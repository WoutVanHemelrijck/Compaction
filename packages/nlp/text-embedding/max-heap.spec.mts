// @author Arwin Gorissen
// @date 2025-03-12

import { describe, it, expect, beforeEach } from 'vitest';
import { maxHeap } from './max-heap.mjs';
import { Node } from './node.mjs';

describe('maxHeap', () => {
  let heap: maxHeap;
  let n1: Node;
  let n2: Node;
  let n3: Node;
  let n4: Node;
  let n5: Node;

  beforeEach(() => {
    heap = new maxHeap();
    n1 = new Node([], 'a', 0);
    n2 = new Node([], 'b', 0);
    n3 = new Node([], 'c', 0);
    n4 = new Node([], 'd', 0);
    n5 = new Node([], 'e', 0);
  });

  it('add test', () => {
    heap.add(n1.docID, 1);
    expect(heap.getMax()).toEqual(n1.docID);
    heap.add(n2.docID, 4);
    expect(heap.getMax()).toEqual(n2.docID);
    heap.add(n3.docID, 2);
    expect(heap.getMax()).toEqual(n2.docID);
    heap.add(n4.docID, 3);
    heap.add(n5.docID, 5);
    expect(heap.getData()).toEqual([n5.docID, n2.docID, n3.docID, n1.docID, n4.docID]);
  });

  it('removeMax test', () => {
    heap.add(n1.docID, 2);
    heap.removeMax();
    expect(heap.getData()).toEqual([]);

    heap.add(n1.docID, 2);
    heap.add(n2.docID, 4);
    heap.removeMax();
    expect(heap.getData()).toEqual([n1.docID]);

    heap.add(n3.docID, 3);
    heap.add(n4.docID, 1);
    heap.removeMax();
    expect(heap.getData()).toEqual([n1.docID, n4.docID]);

    heap.add(n5.docID, 5);
    heap.removeMax();
    heap.removeMax();
    expect(heap.getData()).toEqual([n4.docID]);
  });

  it('removeID test', () => {
    heap.add(n1.docID, 1);
    heap.add(n2.docID, 4);
    heap.add(n3.docID, 2);
    heap.add(n4.docID, 3);
    heap.add(n5.docID, 5);

    heap.removeID('d');
    expect(heap.getData()).toEqual([n5.docID, n2.docID, n3.docID, n1.docID]);

    heap.removeID('d');
    heap.removeID('c');
    expect(heap.getData()).toEqual([n5.docID, n2.docID, n1.docID]);
  });
});
