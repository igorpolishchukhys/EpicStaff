import { computed, Injectable, signal } from '@angular/core';

import { FlowOp, invertOp, UndoBatch } from '../core/models/undo-redo-op.model';

/**
 * Per-user, operation-based undo/redo service.
 *
 * Design principles (EST-10):
 * - Each local mutation records a {forward, inverse} op pair.
 * - Undo replays the inverse ops through the normal local mutation path
 *   (NOT applyRemote*) so they broadcast to collaborators.
 * - Redo re-applies the forward ops symmetrically.
 * - A new LOCAL op clears the redo stack (Figma model).
 * - An inbound REMOTE op does NOT clear the redo stack (pure LWW).
 * - Multi-gesture batches (drag, paste, auto-arrange) use beginBatch()/endBatch().
 *   All ops accumulated between those calls collapse into one undo entry.
 * - While replaying undo/redo the `replaying` flag is true so recording sites
 *   skip re-recording the induced mutations.
 *
 * Public-API backward-compat:
 * - setUndoStack([]) / setRedoStack([]) still compile and work — the host
 *   uses them to clear stacks on graph switch/restore.
 * - canUndo / canRedo are signals (unchanged).
 */
@Injectable({
    providedIn: 'root',
})
export class UndoRedoService {
    private readonly undoStack = signal<UndoBatch[]>([]);
    private readonly redoStack = signal<UndoBatch[]>([]);

    /**
     * True while undo/redo replay is in progress.
     * Recording sites check this flag and skip recording when it is true.
     * Encapsulated behind a getter/setter so future instrumenting (e.g. assertions
     * in tests) can intercept transitions without touching every call-site.
     */
    private _replaying = false;

    public get replaying(): boolean {
        return this._replaying;
    }

    public set replaying(value: boolean) {
        this._replaying = value;
    }

    /** Batch accumulator — ops since the last beginBatch(). */
    private batchOps: FlowOp[] | null = null;

    /** True when a batch is currently open. */
    public get isBatchOpen(): boolean {
        return this.batchOps !== null;
    }

    readonly canUndo = computed(() => this.undoStack().length > 0);
    readonly canRedo = computed(() => this.redoStack().length > 0);

    // -----------------------------------------------------------------------
    // Batch API
    // -----------------------------------------------------------------------

    /**
     * Starts accumulating ops into a batch.
     * Call before the first op in a multi-entity gesture (drag-start, paste start, …).
     * Nesting is not supported — if a batch is already open the current one is committed
     * first (with a warning) so state is never permanently poisoned by a leaked batch.
     */
    public beginBatch(): void {
        if (this.batchOps !== null) {
            console.warn('[UndoRedo] beginBatch() called while a batch is already open — closing prior batch first');
            this._closeBatch();
        }
        this.batchOps = [];
    }

    /**
     * Closes the current batch and pushes it onto the undo stack as a single entry.
     * If no ops were recorded the batch is discarded silently.
     * Clears the redo stack (a new local op invalidates redo).
     * Safe to call when no batch is open — treated as a no-op with a warning.
     */
    public endBatch(): void {
        if (this.batchOps === null) {
            console.warn('[UndoRedo] endBatch() called without a matching beginBatch() — ignored');
            return;
        }
        this._closeBatch();
    }

    /**
     * Closes any open batch without committing it. Use in cleanup paths (e.g. component
     * destroyed mid-animation) to ensure no stale batch accumulates ops for later ops.
     * No-op when no batch is open.
     */
    public abortBatch(): void {
        if (this.batchOps !== null) {
            this.batchOps = null;
        }
    }

    // -----------------------------------------------------------------------
    // Single-op recording
    // -----------------------------------------------------------------------

    /**
     * Records a single forward op.
     * If a batch is open the op is accumulated; otherwise it is immediately committed.
     * Clears the redo stack.
     */
    public recordOp(op: FlowOp): void {
        if (this.replaying) {
            // Inside undo/redo replay — do NOT record the induced mutations.
            return;
        }

        if (this.batchOps !== null) {
            this.batchOps.push(op);
            return;
        }

        this._commitBatch([op]);
    }

    // -----------------------------------------------------------------------
    // Undo / Redo execution
    // -----------------------------------------------------------------------

    /**
     * Pops the top undo batch and returns its inverse ops for the caller to execute.
     * Returns null if the stack is empty.
     * Moves the forward batch to the redo stack.
     *
     * The caller (FlowGraphComponent) is responsible for executing the returned ops
     * through the local mutation + broadcast path.
     */
    public popUndo(): UndoBatch | null {
        const stack = this.undoStack();
        if (stack.length === 0) {
            return null;
        }

        const batch = stack[stack.length - 1];
        this.undoStack.update((s) => s.slice(0, -1));
        this.redoStack.update((s) => [...s, batch]);
        return batch;
    }

    /**
     * Pops the top redo batch and returns its forward ops for the caller to execute.
     * Returns null if the stack is empty.
     * Moves the inverse batch back to the undo stack.
     */
    public popRedo(): UndoBatch | null {
        const stack = this.redoStack();
        if (stack.length === 0) {
            return null;
        }

        const batch = stack[stack.length - 1];
        this.redoStack.update((s) => s.slice(0, -1));
        this.undoStack.update((s) => [...s, batch]);
        return batch;
    }

    // -----------------------------------------------------------------------
    // Backward-compatible public methods
    // -----------------------------------------------------------------------

    /**
     * Called by the host on graph switch / restore.
     * Accepts an array (may be empty) to maintain the existing call-site signature.
     * The generic type is constrained to `unknown[]` so `setUndoStack([])` compiles.
     * The parameter value is intentionally ignored — we always clear to empty.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public setUndoStack(_stack: unknown[]): void {
        this.undoStack.set([]);
    }

    /**
     * Called by the host on graph switch / restore.
     * The parameter value is intentionally ignored — we always clear to empty.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public setRedoStack(_stack: unknown[]): void {
        this.redoStack.set([]);
    }

    /**
     * Clears both stacks. Convenience alias for host code that may call this directly.
     */
    public clear(): void {
        this.undoStack.set([]);
        this.redoStack.set([]);
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /** Closes the current batch, committing it if non-empty. Assumes batchOps !== null. */
    private _closeBatch(): void {
        const ops = this.batchOps!;
        this.batchOps = null;
        if (ops.length > 0) {
            this._commitBatch(ops);
        }
    }

    private _commitBatch(ops: FlowOp[]): void {
        const forward: readonly FlowOp[] = ops;
        const inverse: readonly FlowOp[] = [...ops].reverse().map(invertOp);

        const batch: UndoBatch = { forward, inverse };
        this.undoStack.update((s) => [...s, batch]);
        // A new local op clears redo (remote ops do NOT call recordOp, so they never clear redo).
        this.redoStack.set([]);
    }
}
