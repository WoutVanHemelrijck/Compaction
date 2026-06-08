// @author Arwin Gorissen
// @date 2025-03-12

import { Node } from './node.mjs';

type DocID = string;

/**
 * A heap implementation that stores a map of nodes to distances and sorts them in descending order.
 */
export class maxHeap {
  private data: Array<DocID> = [];
  private map: Map<DocID, number> = new Map<DocID, number>();

  /**
   * Add a node to the heap.
   *
   * @param {DocID} docID - The ID of the node to add to the heap.
   * @param {number} dist - The distance used to sort the node into the heap.
   */
  add(docID: DocID, dist: number) {
    this.data.push(docID);
    this.map.set(docID, dist);

    this.bubbleUp();
  }

  /**
   * Heapify upward.
   *
   * @param {number} idx - The index to bubbleUp if applicable.
   */
  private bubbleUp(idx: number = this.data.length - 1) {
    while (idx > 0) {
      const parentIndex: number = Math.floor((idx - 1) / 2);
      const thisDistance: number = this.map.get(this.data[idx])!;
      const parentDistance: number = this.map.get(this.data[parentIndex])!;

      if (thisDistance <= parentDistance) {
        break;
      }

      [this.data[idx], this.data[parentIndex]] = [this.data[parentIndex], this.data[idx]];

      idx = parentIndex;
    }
  }

  /**
   * Removes the first node (highest distance) from the heap.
   *
   * @returns {DocID} The removed node.
   * @throws {Error} - If the heap is empty.
   */
  removeMax(): DocID {
    if (this.data.length === 0) {
      throw new Error('Heap is empty.');
    }

    //No bubbledown if only 1 element in heap
    if (this.data.length === 1) {
      return this.data.pop()!;
    }

    const res: DocID = this.data[0];
    this.data[0] = this.data.pop()!;
    this.map.delete(res);

    this.bubbleDown();
    return res;
  }

  /**
   * Heapify downward.
   *
   * @param {number} idx - The index at which to remove. If no index given the first element is removed.
   */
  private bubbleDown(idx: number = 0) {
    const length: number = this.data.length;

    while (true) {
      const leftChildIxd: number = idx * 2 + 1;
      const rightChildIdx: number = idx * 2 + 2;
      let largestDistIdx: number = idx;

      const leftChildDist: number = this.map.get(this.data[leftChildIxd])!;
      const rightChildDist: number = this.map.get(this.data[rightChildIdx])!;
      const largestDist: number = this.map.get(this.data[largestDistIdx])!;

      if (leftChildIxd < length && leftChildDist > largestDist) {
        largestDistIdx = leftChildIxd;
      }
      if (rightChildIdx < length && rightChildDist > largestDist) {
        largestDistIdx = rightChildIdx;
      }

      //If no switch with children heapifying is done.
      if (largestDistIdx === idx) return;

      [this.data[idx], this.data[largestDistIdx]] = [this.data[largestDistIdx], this.data[idx]];
      idx = largestDistIdx;
    }
  }

  /**
   * @returns {boolean} - True if the heap is not empty.
   */
  notEmpty(): boolean {
    return this.data.length !== 0;
  }

  /**
   * @returns {DocID} Returns the first node (highest distance).
   */
  getMax(): DocID {
    return this.data[0];
  }

  /**
   * @param {Node} node - The node to get the distance from.
   * @returns {number} The distance to the node.
   * @throws {Error} - If the node is not present in the heap.
   */
  getDist(node: Node): number {
    if (this.map.get(node.docID) === undefined) {
      throw new Error('Node not present in heap.');
    }
    return this.map.get(node.docID)!;
  }

  /**
   * @returns {number} The number nodes in the heap.
   */
  size(): number {
    return this.data.length;
  }

  /**
   * @returns {Array<DocID>} The contents of the heap.
   */
  getData(): Array<DocID> {
    return this.data;
  }

  /**
   * @returns {Map<DocID, number>} The map with DocID's to distances.
   */
  getMap(): Map<DocID, number> {
    return this.map;
  }

  /**
   * Removes an element with a given ID from the heap.
   *
   * @param {DocID} id - The ID of the node to remove.
   */
  removeID(id: DocID) {
    let idx: number = -1;
    let found: boolean = false;
    for (const n of this.data) {
      if (n === id) {
        idx++;
        found = true;
        break;
      }
      idx++;
    }

    if (!found) {
      return;
    }
    this.map.delete(this.data[idx]);

    if (idx === this.data.length - 1) {
      this.data.pop();
      return;
    }
    if (idx === 0) {
      this.data[0] = this.data.pop()!;
      this.bubbleDown();
      return;
    }

    const parentIdx: number = Math.floor((idx - 1) / 2);
    this.data[idx] = this.data.pop()!;

    if (this.map.get(this.data[idx])! > this.map.get(this.data[parentIdx])!) {
      this.bubbleUp(idx);
    } else {
      this.bubbleDown(idx);
    }
  }
}
