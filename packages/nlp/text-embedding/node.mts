// @author Arwin Gorissen
// @date 2025-03-12

import { maxHeap } from './max-heap.mjs';

type DocID = string;

export class Node {
  vector: Array<number>;
  docID: DocID;
  neighbours: Array<maxHeap> = [];
  layer!: number;

  /**
   * Constructor.
   *
   * @param {Array<number>} vector - The vector embedding of the associated file.
   * @param {string} docID - The docID of the associated file.
   * @param {number} layer - The amount of layers in the hnsw.
   */
  constructor(vector: Array<number>, docID: DocID, layer: number) {
    this.vector = vector;
    this.docID = docID;
    for (let i = 0; i < layer; i++) {
      this.neighbours.push(new maxHeap());
    }
  }

  /**
   * Sets the layer of the node.
   *
   * @param {number} layer - Layer you want to set.
   * @throws {Error} If the layer is higher than the highest layer of the hnsw index.
   */
  setLayer(layer: number) {
    if (layer > this.neighbours.length - 1) {
      throw new Error(`Layer must me smaller than layercount ${this.neighbours.length - 1}, you gave: ${layer}.`);
    }
    this.layer = layer;
  }

  /**
   * Sets the neighbours of the node.
   *
   * @param {Array<maxHeap>} neighbours - The neighbours you want to set.
   */
  setNeighbours(neighbours: Array<maxHeap>) {
    this.neighbours = neighbours;
  }

  /**
   * Tries to add a neighbour at a certain layer.
   *
   * @param {Node} node - The node to add to neighbours.
   * @param {number} layer - The layer at which to add the node.
   * @param {number} M - The miximum amount of neighbours the node can have at that layer.
   */
  addNeighbour(node: Node, layer: number, M: number, dist: number) {
    this.neighbours[layer].add(node.docID, dist);

    if (this.neighbours[layer].size() > M) {
      this.neighbours[layer].removeMax();
    }
  }

  /**
   * Remove a node as neighbour.
   *
   * @param {Node} node - The node to remove.
   */
  remove(node: Node) {
    for (const h of this.neighbours) {
      h.removeID(node.docID);
    }
  }
}
