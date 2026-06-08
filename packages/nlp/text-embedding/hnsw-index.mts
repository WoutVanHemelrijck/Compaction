// @author Arwin Gorissen
// @date 2025-04-19

import { cosineDistance } from './find-similar.mjs';
import { Node } from './node.mjs';
import { maxHeap } from './max-heap.mjs';
import { pipeline } from '@huggingface/transformers';
import { FreeBlockFile } from '../../dbms/storage/freeblockfile.mjs';
import { diskStorageImpl } from './disk-storage.mjs';
import { File } from '../../dbms/storage/file/file.mjs';
import { Collection } from '../../dbms/core/simpledbms.mjs';

const NIL_UUID: string = '00000000-0000-0000-0000-000000000000';

type DocID = string;

interface SimpleExtractor {
  (
    text: string,
    options?: { pooling?: string; normalize?: boolean },
  ): Promise<{
    data: Float32Array | number[];
  }>;
}

/**
 * Interface to interact with hsnw index.
 */
export interface hnswIndex {
  init(): Promise<void>;
  open(): Promise<void>;
  insert(txt: string, id: DocID): Promise<void>;
  search(query: string, nBestMatches: number): Promise<Array<DocID>>;
  delete(ID: DocID): Promise<void>;
  commitToWal(): Promise<void>;
  commitToDisk(): Promise<void>;
  close(): Promise<void>;
}

/**
 * A class to create and interact with an HNSW.
 */
export class hnswIndexImpl implements hnswIndex {
  public readonly layerCount: number;
  private M: number;
  public readonly Mmax: number;
  private m_L: number;
  private efConstruction: number;
  private efSearch: number;
  public entryNode: Node | null = null;
  private maxLayer: number = 0;
  public docIDMap: Map<DocID, Node> = new Map<DocID, Node>();
  private extractor!: SimpleExtractor;
  public diskStorage: diskStorageImpl;
  public collection!: Collection;
  private walFile: File;
  private walOffset: number = 0;

  /**
   * @param {number} layerCount - Amount of layers in the HNSW.
   * @param {number} M - Amount of neighbours a node is assigned on insert.
   * @param {number} Mmax - Max amount of neighbours a node is allowed to have.
   * @param {number} efConstruction - The amount of candidates checked when inserting a new node.
   * @param {number} efSearch - The amount of candidates checked when searching the HNSW.
   * @param {FreeBlockFile} fbFile - The freeblockfile used to write to disk.
   * @param {FreeBlockFile} fbfile2 - The freeblockfile used by the BplusTree of disk storage.
   * @param {File} walFile - The walFile for disk storage.
   */
  constructor(
    layerCount: number,
    M: number,
    Mmax: number,
    efConstruction: number,
    efSearch: number,
    fbFile: FreeBlockFile,
    fbfile2: FreeBlockFile,
    walFile: File,
  ) {
    this.layerCount = layerCount;
    this.M = M;
    this.Mmax = Mmax;
    this.m_L = 1 / Math.log(M); //Rule of thumb for optimal m_L value.
    this.efConstruction = efConstruction;
    this.efSearch = efSearch;
    this.diskStorage = new diskStorageImpl(fbFile, fbfile2, this);
    this.walFile = walFile;
  }

  /**
   * Initialize the hnsw-index. Called only once.
   */
  async init() {
    await this.diskStorage.init();
  }

  /**
   * Open the hnsw-index.
   *
   * @throws {Error} If the hnsw index has not been initialized yet.
   */
  async open() {
    if (await this.diskStorage.getInit()) {
      throw new Error('Hnsw index not initialized yet. Use init().');
    }

    this.extractor = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'fp32',
    })) as unknown as SimpleExtractor;

    await this.walFile.open();
    await this.diskStorage.open();

    //Check for a crash
    const size: number = (await this.walFile.stat()).size;
    if (size > 0) {
      await this.recoverAfterCrash(size);
    }
  }

  /**
   * Create vector embedding of a text.
   *
   * @param {string} txt - The text to convert to a vector embedding.
   * @returns {Float32Array} A Float32Array with the vector embedding.
   * @throws {Error} If the hnsw index has not been opened yet.
   */
  private async getVectorEmbedding(txt: string): Promise<Float32Array> {
    if (!this.extractor) {
      throw new Error('Hnsw index not opened yet. Use open().');
    }

    const out = await this.extractor(txt, { pooling: 'mean', normalize: true });
    return out.data as Float32Array;
  }

  /**
   * Insert a new document in the HNSW.
   *
   * @param {string} txt - Tekst of the document to insert.
   * @param {DocID} id - The docID of the document to insert.
   * @throws {Error} If the hnsw index has not been opened yet.
   */
  async insert(txt: string, id: DocID) {
    //console.log('insert()');
    if (!this.extractor) {
      throw new Error('Hnsw index not opened yet. Use open().');
    }

    const vectorEmbedding: Float32Array = await this.getVectorEmbedding(txt);
    const node: Node = new Node(Array.from(vectorEmbedding), id, this.layerCount);

    node.setLayer(this.getInsertLayer());
    this.docIDMap.set(node.docID, node);
    this.diskStorage.addNode(node);

    if (!this.entryNode) {
      this.entryNode = node;
      this.maxLayer = node.layer;
      return;
    }

    let nearestNeighbour: Node = this.entryNode;

    const neighbours: maxHeap[] = [];

    //Add empty heaps for layers that have no nodes yet
    for (let l = this.layerCount - 1; l > this.maxLayer; l--) {
      neighbours.unshift(new maxHeap());
    }
    //Add empty heaps for layers > node.layer
    for (let l = this.maxLayer; l > node.layer; l--) {
      nearestNeighbour = await this.getLocalMinimum(node.vector, nearestNeighbour, l);
      neighbours.unshift(new maxHeap());
    }
    //Search for neighbours
    for (let i = Math.min(node.layer, this.maxLayer); i >= 0; i--) {
      //Add empty heap if node.layer > entryNode.layer
      if (node.layer > nearestNeighbour.layer) {
        neighbours.unshift(new maxHeap());
      } else {
        neighbours.unshift(await this.findNeighbours(node, nearestNeighbour, i, this.efConstruction, true));
      }

      //Update neighbours (a neighbour on layer l is also neighbour on every layer < l)
      for (const n of neighbours[0].getData()) {
        const neighbour: Node = await this.getNode(n);
        neighbour.addNeighbour(node, i, this.Mmax, neighbours[0].getDist(neighbour));
        this.diskStorage.addNode(neighbour);
      }

      if (!(neighbours[0].getData()[0] === undefined)) {
        nearestNeighbour = await this.getNode(neighbours[0].getMax());
      }
    }

    node.setNeighbours(neighbours);

    if (node.layer > this.maxLayer) {
      this.maxLayer = node.layer;
      this.entryNode = node;
    }
  }

  /**
   * Randomnly generates the layer at which to insert a new document.
   *
   * @returns {number} - The layer at which to insert a new document.
   */
  private getInsertLayer(): number {
    return Math.min(this.layerCount - 1, Math.floor(-Math.log(Math.random()) * this.m_L));
  }

  /**
   * Finds the local minimum distance of a vector to others on a given layer.
   *
   * @param {Array<number>} vector - The vector searching its nearest neighbour.
   * @param {Node} entry - The entry node in the given layer.
   * @returns {Node} - The local minimum node (smallest distance).
   */
  private async getLocalMinimum(vector: Array<number>, entry: Node, layer: number): Promise<Node> {
    //console.log('findLocalMinimum()');
    let searchNode: Node = entry;

    while (true) {
      let bestNode: Node = searchNode;
      let bestDist: number = cosineDistance(vector, bestNode.vector);
      for (const n of searchNode.neighbours[layer].getData()) {
        const dist: number = cosineDistance(vector, (await this.getNode(n)).vector);
        if (dist < bestDist) {
          bestNode = await this.getNode(n);
          bestDist = dist;
        }
      }
      //Break if no improvement made
      if (bestNode === searchNode) {
        return searchNode;
      } else {
        searchNode = bestNode;
      }
    }
  }

  /**
   * Finds M neighbours for a new node in a certain layer.
   *
   * @param {Node} node - The new node to search neighbours for.
   * @param {Node} entry - The nearest neighbour in layer zero.
   * @param {number} layer - The layer in which to search.
   * @param {number} ef - EfConstruction or EfSearch.
   * @param {boolean} returnMaxHeap - return a maxheap or a minheap
   * @returns {maxHeap<Node>} - The neighbours of the new node in layer 'layer'.
   */
  private async findNeighbours(
    node: Node,
    entry: Node,
    layer: number,
    ef: number,
    returnMaxHeap: boolean,
  ): Promise<maxHeap> {
    //console.log('finNeighbours()');
    const visited: Set<DocID> = new Set<DocID>();
    const neighbours: maxHeap = new maxHeap();
    const neighboursMin: maxHeap = new maxHeap(); // maxHeap storing negative distances (functionally a minHeap)
    const candidates: maxHeap = new maxHeap(); // maxHeap storing negative distances (functionally a minHeap)

    let dist: number = cosineDistance(node.vector, entry.vector);
    candidates.add(entry.docID, -dist);
    neighbours.add(entry.docID, dist);
    neighboursMin.add(entry.docID, -dist);
    visited.add(entry.docID);

    while (candidates.notEmpty()) {
      const candidateDist: number = candidates.getDist(await this.getNode(candidates.getMax()));
      const candidate: Node = await this.getNode(candidates.removeMax());
      const worst: Node = await this.getNode(neighbours.getMax());
      //Stop search when the best candidate is worse than the worst find
      if (Math.abs(candidateDist) > neighbours.getDist(worst)) {
        break;
      }

      for (const n of candidate.neighbours[layer].getData()) {
        const nod: Node = await this.getNode(n);
        if (!visited.has(nod.docID)) {
          visited.add(nod.docID);
          dist = cosineDistance(nod.vector, node.vector);

          if (neighbours.size() < ef || dist < neighbours.getDist(await this.getNode(neighbours.getMax()))) {
            neighbours.add(nod.docID, dist);
            neighboursMin.add(nod.docID, -dist);
            candidates.add(nod.docID, -dist);
          }
          if (neighbours.size() > ef) {
            neighbours.removeMax();
          }
        }
      }
    }
    while (neighbours.size() > this.M) {
      neighbours.removeMax();
    }
    return returnMaxHeap ? neighbours : neighboursMin;
  }

  /**
   * Searches the HNSW and returns the docID of the closest node.
   *
   * @param {string} query - The query.
   * @param {number} nBestMatches - The number of best matches to return.(Optional)
   * @returns {Array<DocID>} The best matches.
   * @throws {Error} If the HNSW is empty.
   * @throws {Error} If the hnsw index has not been opened yet.
   * @throws {Error} If nBestMatches < 1.
   */
  async search(query: string, nBestMatches: number = 1): Promise<Array<DocID>> {
    //console.log('search()');
    if (this.entryNode === null) {
      throw new Error('HNSW is empty.');
    }
    if (!this.extractor) {
      throw new Error('Hnsw index not opened yet. Use open().');
    }
    if (nBestMatches < 1) {
      throw new Error('Only a strictly positive amount of best matches can be returned.');
    }

    const embeddedVector: Float32Array = await this.getVectorEmbedding(query);

    let entry: Node = this.entryNode;

    for (let i = this.maxLayer; i >= 0; i--) {
      entry = await this.getLocalMinimum(Array.from(embeddedVector), entry, i);
    }

    const queryNode: Node = new Node(Array.from(embeddedVector), '-2', this.layerCount);
    const res: maxHeap = await this.findNeighbours(queryNode, entry, 0, this.efSearch, false);

    const bestMatches: Array<DocID> = [];
    for (let i = 0; i < nBestMatches; i++) {
      bestMatches.push(res.getMax());
      if (res.notEmpty()) {
        res.removeMax();
      }
    }

    return bestMatches;
  }

  /**
   * Delete a node from the HNSW.
   *
   * @param {DocID} ID - The ID of the node to delete.
   * @throws {Error} If there exists no node with the ID.
   * @throws {Error} If the hnsw index has not been opened yet.
   */
  async delete(ID: DocID) {
    if (!(await this.getNode(ID))) {
      throw new Error(`No document with ID: ${ID} found.`);
    }
    if (!this.extractor) {
      throw new Error('Hnsw index not opened yet. Use open().');
    }

    const node: Node = await this.getNode(ID);
    for (const h of node.neighbours) {
      for (const n of h.getData()) {
        (await this.getNode(n)).remove(node);
      }
    }

    this.docIDMap.delete(ID);
    await this.diskStorage.delete(ID);
  }

  /**
   * Helper to get a node or load it from disk if it's not yet in memory.
   *
   * @param {DocID} docID - The ID of the node you want to retrieve.
   * @returns {Node} The node.
   */
  private async getNode(docID: DocID): Promise<Node> {
    if (!this.docIDMap.has(docID)) {
      return await this.diskStorage.loadFromDisk(docID);
    }
    return this.docIDMap.get(docID)!;
  }

  /**
   * Commit all new uncomitted data to wal.
   * This should be done at the same time as the data is committed to the database to ensure consistency.
   *
   * @throws {Error} If the hnsw index has not been opened yet.
   */
  async commitToWal() {
    if (!this.extractor) {
      throw new Error('Hnsw index not opened yet. Use open().');
    }

    await this.walFile.truncate(0);

    for (const n of this.docIDMap.values()) {
      const idBuffer: Buffer<ArrayBuffer> = Buffer.from(n.docID.replace(/-/g, ''), 'hex');
      await this.walFile.writev([idBuffer], this.walOffset);
      this.walOffset += 16;
    }

    //Write NIL ID as commit marker
    const NIL_UUID: DocID = '00000000-0000-0000-0000-000000000000';
    const marker: Buffer<ArrayBuffer> = Buffer.from(NIL_UUID.replace(/-/g, ''), 'hex');
    await this.walFile.writev([marker], this.walOffset);

    await this.walFile.sync();
  }

  /**
   * Commit all nodes to disk.
   *
   * @throws {Error} If the hnsw index has not been opened yet.
   */
  async commitToDisk() {
    if (!this.extractor) {
      throw new Error('Hnsw index not opened yet. Use open().');
    }

    await this.diskStorage.commitToDisk();
  }

  /**
   * Recover data from the wal in case of a crash.
   *
   * @param {number} size - The size of the wal.
   */
  private async recoverAfterCrash(size: number) {
    //console.log('recoverfromcrash()');
    const buffer: Buffer<ArrayBuffer> = Buffer.alloc(size);
    await this.walFile.read(buffer, { position: 0 });

    const marker: Buffer<ArrayBuffer> = buffer.slice(buffer.length - 16, buffer.length);
    if (this.diskStorage.readUUID(marker) === NIL_UUID) {
      let idx: number = 0;
      while (idx < size - 16) {
        const idBuffer: Buffer<ArrayBuffer> = buffer.slice(idx, idx + 16);
        const id: DocID = this.diskStorage.readUUID(idBuffer);
        const text = Object.values((await this.collection.findById(id))!)
          .filter((v): v is string => typeof v === 'string')
          .join(' ');

        await this.insert(text, id);
        idx += 16;
      }
      await this.commitToDisk();
    }
    await this.walFile.truncate(0);
  }

  /**
   * Safely close the hnsw.
   *
   * @throws {Error} If the hnsw index has not been opened yet.
   */
  async close() {
    if (!this.extractor) {
      throw new Error('Hnsw index not opened yet. Use open().');
    }

    await this.diskStorage.close();
    await this.walFile.truncate(0);
    await this.walFile.sync();
  }
}
