/**
 * @file queue.ts
 * @description Generic async priority queue implementation using a binary heap.
 *              Supports push(item, priority) and pop(). Used by the SimulationEngine
 *              and ExecutionEngine to order opportunities by estimated profit.
 */

export interface QueueItem<T> {
  item: T;
  priority: number;
}

/**
 * A max-priority queue implemented with a binary heap.
 * Higher priority items are dequeued first.
 */
export class PriorityQueue<T> {
  private heap: QueueItem<T>[];

  constructor() {
    this.heap = [];
  }

  /**
   * Returns the number of items in the queue.
   */
  get size(): number {
    return this.heap.length;
  }

  /**
   * Returns true if the queue is empty.
   */
  get isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Adds an item to the queue with the given priority.
   * @param item The item to add.
   * @param priority The priority (higher = dequeued first).
   */
  push(item: T, priority: number): void {
    this.heap.push({ item, priority });
    this._bubbleUp(this.heap.length - 1);
  }

  /**
   * Removes and returns the highest-priority item.
   * @returns The item with the highest priority, or undefined if empty.
   */
  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;

    const top = this.heap[0];
    const last = this.heap.pop()!;

    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }

    return top.item;
  }

  /**
   * Returns the highest-priority item without removing it.
   * @returns The item with the highest priority, or undefined if empty.
   */
  peek(): T | undefined {
    return this.heap.length > 0 ? this.heap[0].item : undefined;
  }

  /**
   * Returns the priority of the highest-priority item.
   * @returns The highest priority, or -Infinity if empty.
   */
  peekPriority(): number {
    return this.heap.length > 0 ? this.heap[0].priority : -Infinity;
  }

  /**
   * Removes all items from the queue.
   */
  clear(): void {
    this.heap = [];
  }

  /**
   * Returns all items in the queue as an array, sorted by priority (descending).
   * Does not modify the queue.
   */
  toSortedArray(): T[] {
    return [...this.heap]
      .sort((a, b) => b.priority - a.priority)
      .map((qi) => qi.item);
  }

  /**
   * Drains the queue, returning all items in priority order.
   */
  drain(): T[] {
    const result: T[] = [];
    while (!this.isEmpty) {
      const item = this.pop();
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  /**
   * Bubbles up the element at the given index to maintain heap property.
   */
  private _bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[parentIndex].priority >= this.heap[index].priority) break;
      this._swap(parentIndex, index);
      index = parentIndex;
    }
  }

  /**
   * Sinks down the element at the given index to maintain heap property.
   */
  private _sinkDown(index: number): void {
    const length = this.heap.length;

    while (true) {
      let largest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      if (left < length && this.heap[left].priority > this.heap[largest].priority) {
        largest = left;
      }

      if (right < length && this.heap[right].priority > this.heap[largest].priority) {
        largest = right;
      }

      if (largest === index) break;

      this._swap(index, largest);
      index = largest;
    }
  }

  /**
   * Swaps two elements in the heap.
   */
  private _swap(i: number, j: number): void {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
  }
}

/**
 * A simple async queue that processes items one at a time.
 * Used for serializing execution of arbitrage opportunities.
 */
export class AsyncQueue<T> {
  private queue: T[];
  private processing: boolean;
  private processor: ((item: T) => Promise<void>) | null;
  private _onEmpty: (() => void) | null;

  constructor() {
    this.queue = [];
    this.processing = false;
    this.processor = null;
    this._onEmpty = null;
  }

  /**
   * Sets the processor function that handles each item.
   */
  setProcessor(fn: (item: T) => Promise<void>): void {
    this.processor = fn;
  }

  /**
   * Sets a callback for when the queue becomes empty.
   */
  onEmpty(fn: () => void): void {
    this._onEmpty = fn;
  }

  /**
   * Adds an item to the queue and starts processing if not already running.
   */
  async enqueue(item: T): Promise<void> {
    this.queue.push(item);
    if (!this.processing) {
      await this._processQueue();
    }
  }

  /**
   * Adds multiple items to the queue.
   */
  async enqueueAll(items: T[]): Promise<void> {
    this.queue.push(...items);
    if (!this.processing) {
      await this._processQueue();
    }
  }

  /**
   * Returns the current queue length.
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Clears all pending items from the queue.
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Processes items in the queue sequentially.
   */
  private async _processQueue(): Promise<void> {
    if (!this.processor || this.processing) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await this.processor(item);
      } catch (error) {
        // Processor errors are handled by the processor itself
      }
    }

    this.processing = false;

    if (this._onEmpty) {
      this._onEmpty();
    }
  }
}