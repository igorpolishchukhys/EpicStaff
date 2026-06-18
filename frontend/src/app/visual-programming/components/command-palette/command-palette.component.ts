import { DialogRef } from '@angular/cdk/dialog';
import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    computed,
    ElementRef,
    inject,
    signal,
    ViewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

import { AppSvgIconComponent } from '../../../shared/components/app-svg-icon/app-svg-icon.component';
import { FlowGraphBlock, NODE_BLOCKS } from '../../core/constants/node-blocks';
import { NodeType } from '../../core/enums/node-type';
import { fuzzyMatch } from '../../core/helpers/fuzzy-match';
import { EditorActionId, PaletteResult } from '../../core/models/command-palette.types';
import { FlowService } from '../../services/flow.service';
import { UndoRedoService } from '../../services/undo-redo.service';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/** A node block entry annotated with its disabled state for rendering. */
interface PaletteNodeEntry extends FlowGraphBlock {
    kind: 'node';
    disabled: boolean;
}

/** An action entry annotated with its disabled state for rendering. */
interface PaletteActionEntry {
    kind: 'action';
    id: EditorActionId;
    label: string;
    icon: string;
    shortcut?: readonly string[];
    disabled: boolean;
}

type PaletteRow = PaletteNodeEntry | PaletteActionEntry;

// ---------------------------------------------------------------------------
// Action definitions (palette-specific UI; NOT a shared module concern)
// ---------------------------------------------------------------------------

interface ActionDefinition {
    id: EditorActionId;
    label: string;
    icon: string;
    shortcut?: readonly string[];
}

const ACTION_DEFINITIONS: readonly ActionDefinition[] = [
    { id: EditorActionId.RunFlow, label: 'Run flow', icon: 'ti ti-player-play' },
    { id: EditorActionId.Save, label: 'Save', icon: 'ti ti-device-floppy', shortcut: ['mod', 'S'] },
    { id: EditorActionId.Undo, label: 'Undo', icon: 'ti ti-arrow-back-up', shortcut: ['mod', 'Z'] },
    { id: EditorActionId.Redo, label: 'Redo', icon: 'ti ti-arrow-forward-up', shortcut: ['mod', 'Shift', 'Z'] },
    { id: EditorActionId.FitToScreen, label: 'Fit to screen', icon: 'ti ti-arrows-maximize' },
    { id: EditorActionId.OpenSettings, label: 'Open settings', icon: 'ti ti-settings' },
    { id: EditorActionId.OpenShortcuts, label: 'Open shortcuts', icon: 'ti ti-keyboard', shortcut: ['mod', '/'] },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@Component({
    selector: 'app-command-palette',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [ReactiveFormsModule, AppSvgIconComponent],
    template: `
        <div
            class="backdrop"
            (click)="close()"
        >
            <div
                class="palette-card"
                (click)="$event.stopPropagation()"
                (keydown)="onKeyDown($event)"
                role="dialog"
                aria-modal="true"
                aria-label="Search actions and nodes"
            >
                <div class="palette-header">
                    <div class="search-row">
                        <app-svg-icon
                            class="search-icon"
                            icon="search"
                            size="1rem"
                        ></app-svg-icon>
                        <input
                            #searchInput
                            class="search-input"
                            type="text"
                            placeholder="Search actions and nodes…"
                            autocomplete="off"
                            spellcheck="false"
                            [formControl]="searchControl"
                            aria-label="Search actions and nodes"
                            aria-autocomplete="list"
                            [attr.aria-activedescendant]="activeDescendantId()"
                        />
                        <div class="esc-hint">
                            <span class="esc-label">ESC</span>
                            <app-svg-icon
                                class="close-icon"
                                icon="x"
                                size="1rem"
                                (click)="close()"
                            ></app-svg-icon>
                        </div>
                    </div>
                </div>

                <ul
                    class="node-list"
                    role="listbox"
                    aria-label="Actions and node types"
                >
                    <!-- Actions group -->
                    @if (filteredActions().length > 0) {
                        <li
                            class="group-header"
                            role="presentation"
                        >
                            Actions
                        </li>
                        @for (action of filteredActions(); track action.id; let i = $index) {
                            <li
                                class="node-item action-item"
                                [class.highlighted]="flatIndexOf('action', i) === highlightedIndex()"
                                [class.disabled]="action.disabled"
                                [attr.id]="'palette-action-' + action.id"
                                role="option"
                                [attr.aria-selected]="flatIndexOf('action', i) === highlightedIndex()"
                                [attr.aria-disabled]="action.disabled"
                                (click)="selectRow(action)"
                                (mouseenter)="!action.disabled && highlightedIndex.set(flatIndexOf('action', i))"
                            >
                                <i
                                    class="node-icon action-icon"
                                    [class]="action.icon"
                                ></i>
                                <span class="node-label">{{ action.label }}</span>
                                @if (action.shortcut) {
                                    <span class="shortcut-chips">
                                        @for (token of action.shortcut; track token) {
                                            <span class="esc-label key-chip">{{ renderToken(token) }}</span>
                                        }
                                    </span>
                                }
                            </li>
                        }
                    }

                    <!-- Nodes group -->
                    @if (filteredEntries().length > 0) {
                        <li
                            class="group-header"
                            role="presentation"
                        >
                            Nodes
                        </li>
                        @for (entry of filteredEntries(); track entry.type; let i = $index) {
                            <li
                                class="node-item"
                                [class.highlighted]="flatIndexOf('node', i) === highlightedIndex()"
                                [class.disabled]="entry.disabled"
                                [attr.id]="'palette-option-' + entry.type"
                                role="option"
                                [attr.aria-selected]="flatIndexOf('node', i) === highlightedIndex()"
                                [attr.aria-disabled]="entry.disabled"
                                (click)="selectRow(entry)"
                                (mouseenter)="!entry.disabled && highlightedIndex.set(flatIndexOf('node', i))"
                            >
                                <span
                                    class="node-color-bar"
                                    [style.background-color]="entry.color"
                                ></span>
                                <i
                                    class="node-icon"
                                    [class]="entry.icon"
                                    [style.color]="entry.color"
                                ></i>
                                <span class="node-label">{{ entry.label }}</span>
                                @if (entry.disabled) {
                                    <span class="disabled-hint">Already added</span>
                                }
                            </li>
                        }
                    }

                    @if (filteredActions().length === 0 && filteredEntries().length === 0) {
                        <li class="no-results">No results match "{{ searchControl.value }}"</li>
                    }
                </ul>
            </div>
        </div>
    `,
    styles: [
        `
            .backdrop {
                position: fixed;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(0, 0, 0, 0.45);
                z-index: 1000;
            }

            .palette-card {
                background-color: var(--color-modals-background, #222225);
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                width: 560px;
                max-width: 90vw;
                max-height: 80vh;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                color: var(--color-text-primary, #d9d9de);
            }

            .palette-header {
                padding: 1rem;
                flex-shrink: 0;
            }

            .search-row {
                display: flex;
                align-items: center;
                gap: 0.625rem;
                background-color: var(--color-input-background, #27272b);
                border: 1px solid var(--color-input-border, #c8ceda24);
                border-radius: 8px;
                padding: 0.5rem 0.75rem;
                transition: border-color 0.15s ease;
            }

            .search-row:focus-within {
                border-color: var(--accent-color, #685fff);
            }

            .search-icon {
                color: var(--color-text-primary, #d9d9de);
                opacity: 0.5;
                flex-shrink: 0;
            }

            .search-input {
                flex: 1;
                background: transparent;
                border: none;
                outline: none;
                color: var(--color-text-primary, #d9d9de);
                font-size: 0.9375rem;
                font-family: inherit;
                min-width: 0;
            }

            .search-input::placeholder {
                color: var(--color-text-primary, #d9d9de);
                opacity: 0.4;
            }

            .esc-hint {
                display: flex;
                align-items: center;
                gap: 0.375rem;
                flex-shrink: 0;
            }

            .esc-label {
                font-size: 0.6875rem;
                font-weight: 500;
                color: var(--color-text-primary, #d9d9de);
                padding: 0.125rem 0.3rem;
                border: 1px solid currentColor;
                border-radius: 4px;
                line-height: 1.4;
                opacity: 0.4;
            }

            .close-icon {
                cursor: pointer;
                opacity: 0.5;
                transition:
                    opacity 0.15s ease,
                    transform 0.15s ease;
            }

            .close-icon:hover {
                opacity: 1;
                transform: scale(1.1);
                color: var(--accent-color, #685fff);
            }

            /* Group headers */

            .group-header {
                list-style: none;
                padding: 0.375rem 0.75rem 0.25rem;
                font-size: 0.6875rem;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.06em;
                color: var(--color-text-primary, #d9d9de);
                opacity: 0.45;
                user-select: none;
            }

            /* Node list */

            .node-list {
                list-style: none;
                margin: 0;
                padding: 0 0.5rem 0.5rem;
                overflow-y: auto;
                flex: 1;
            }

            .node-item {
                display: flex;
                align-items: center;
                gap: 0.75rem;
                padding: 0.625rem 0.75rem;
                border-radius: 8px;
                cursor: pointer;
                transition: background 0.1s ease;
                position: relative;
                user-select: none;
            }

            .node-item:hover:not(.disabled),
            .node-item.highlighted:not(.disabled) {
                background-color: var(--color-item-hover, rgba(255, 255, 255, 0.06));
            }

            .node-item.highlighted:not(.disabled) {
                outline: 1px solid var(--accent-color, #685fff);
                outline-offset: -1px;
            }

            .node-item.disabled {
                opacity: 0.4;
                cursor: not-allowed;
            }

            .node-color-bar {
                width: 3px;
                height: 1.25rem;
                border-radius: 2px;
                flex-shrink: 0;
            }

            .node-icon {
                font-size: 1.125rem;
                flex-shrink: 0;
                width: 1.25rem;
                text-align: center;
            }

            /* Action rows: icon in accent color, no color bar */
            .action-item {
                padding-left: 0.75rem;
            }

            .action-icon {
                color: var(--accent-color, #685fff);
            }

            .node-label {
                flex: 1;
                font-size: 0.9375rem;
                color: var(--color-text-primary, #d9d9de);
            }

            .disabled-hint {
                font-size: 0.75rem;
                opacity: 0.6;
                color: var(--color-text-primary, #d9d9de);
            }

            /* Shortcut key chips */

            .shortcut-chips {
                display: flex;
                align-items: center;
                gap: 0.25rem;
                flex-shrink: 0;
            }

            .key-chip {
                /* Inherits .esc-label base; add slight size variation for readability */
                font-size: 0.625rem;
            }

            .no-results {
                padding: 1rem 0.75rem;
                color: var(--color-text-primary, #d9d9de);
                opacity: 0.5;
                font-size: 0.875rem;
            }
        `,
    ],
})
export class CommandPaletteComponent implements AfterViewInit {
    // --- ViewChild ---
    @ViewChild('searchInput') private readonly searchInputRef!: ElementRef<HTMLInputElement>;

    // --- Signals & Computed ---
    readonly highlightedIndex = signal(0);

    readonly filteredActions = computed<PaletteActionEntry[]>(() => {
        const query = this.querySignal() ?? '';
        const canUndo = this.undoRedo.canUndo();
        const canRedo = this.undoRedo.canRedo();

        const toEntry = (def: ActionDefinition): PaletteActionEntry => ({
            kind: 'action',
            id: def.id,
            label: def.label,
            icon: def.icon,
            shortcut: def.shortcut,
            disabled: (def.id === EditorActionId.Undo && !canUndo) || (def.id === EditorActionId.Redo && !canRedo),
        });

        if (query.trim().length === 0) {
            return ACTION_DEFINITIONS.map(toEntry);
        }

        const scored: { def: ActionDefinition; score: number }[] = [];
        for (const def of ACTION_DEFINITIONS) {
            const score = fuzzyMatch(query, def.label);
            if (score !== null) {
                scored.push({ def, score });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.map(({ def }) => toEntry(def));
    });

    readonly filteredEntries = computed<PaletteNodeEntry[]>(() => {
        const query = this.querySignal() ?? '';
        const hasEnd = this.flowService.hasEndNode();

        const toEntry = (block: FlowGraphBlock): PaletteNodeEntry => ({
            ...block,
            kind: 'node',
            disabled: block.type === NodeType.END && hasEnd,
        });

        if (query.trim().length === 0) {
            return NODE_BLOCKS.map(toEntry);
        }

        const scored: { block: FlowGraphBlock; score: number }[] = [];
        for (const block of NODE_BLOCKS) {
            const score = fuzzyMatch(query, block.label);
            if (score !== null) {
                scored.push({ block, score });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.map(({ block }) => toEntry(block));
    });

    /** Flat ordered list of all visible rows: actions first, then nodes. */
    private readonly flatRows = computed<PaletteRow[]>(() => [...this.filteredActions(), ...this.filteredEntries()]);

    readonly activeDescendantId = computed<string | null>(() => {
        const rows = this.flatRows();
        const index = this.highlightedIndex();
        if (index < 0 || index >= rows.length) return null;
        const row = rows[index];
        return row.kind === 'action' ? `palette-action-${row.id}` : `palette-option-${row.type}`;
    });

    // --- Public template-bound properties ---

    /** Whether we are on macOS — used to render 'mod' token as ⌘ vs Ctrl. */
    readonly isMac =
        typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

    // --- Private fields ---
    readonly searchControl = new FormControl('', { nonNullable: true });

    private readonly querySignal = toSignal(this.searchControl.valueChanges, {
        initialValue: '',
    });

    private readonly dialogRef = inject(DialogRef<PaletteResult>);
    private readonly flowService = inject(FlowService);
    private readonly undoRedo = inject(UndoRedoService);

    constructor() {
        // Reset highlight to first enabled row whenever the filter changes.
        this.searchControl.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
            this.highlightedIndex.set(this.findFirstEnabled());
        });
    }

    // --- Lifecycle ---
    ngAfterViewInit(): void {
        this.searchInputRef.nativeElement.focus();
        // Set initial highlight after view initialises so signals are settled.
        this.highlightedIndex.set(this.findFirstEnabled());
    }

    // --- Public methods ---

    /** Returns the flat index for an action or node row by its within-group index. */
    flatIndexOf(group: 'action' | 'node', groupIndex: number): number {
        if (group === 'action') {
            return groupIndex;
        }
        return this.filteredActions().length + groupIndex;
    }

    /** Renders a shortcut modifier token as the platform-correct label. */
    renderToken(token: string): string {
        if (token === 'mod') {
            return this.isMac ? '⌘' : 'Ctrl';
        }
        return token;
    }

    onKeyDown(event: KeyboardEvent): void {
        switch (event.key) {
            case 'ArrowDown': {
                event.preventDefault();
                const next = this.findNextEnabled(this.highlightedIndex(), 1);
                if (next !== null) {
                    this.highlightedIndex.set(next);
                }
                break;
            }
            case 'ArrowUp': {
                event.preventDefault();
                const prev = this.findNextEnabled(this.highlightedIndex(), -1);
                if (prev !== null) {
                    this.highlightedIndex.set(prev);
                }
                break;
            }
            case 'Enter': {
                event.preventDefault();
                const rows = this.flatRows();
                const row = rows[this.highlightedIndex()];
                if (row && !row.disabled) {
                    this.selectRow(row);
                }
                break;
            }
            case 'Escape': {
                event.preventDefault();
                this.close();
                break;
            }
        }
    }

    selectRow(row: PaletteRow): void {
        if (row.disabled) {
            return;
        }
        if (row.kind === 'action') {
            this.dialogRef.close({ kind: 'action', actionId: row.id });
        } else {
            this.dialogRef.close({ kind: 'create-node', request: { type: row.type } });
        }
    }

    close(): void {
        this.dialogRef.close();
    }

    // --- Private methods ---

    /**
     * Returns the flat index of the first enabled row, or 0 if all are disabled.
     */
    private findFirstEnabled(): number {
        const rows = this.flatRows();
        for (let i = 0; i < rows.length; i++) {
            if (!rows[i].disabled) return i;
        }
        return 0;
    }

    /**
     * Starting from `fromIndex`, walks in `direction` (+1 or -1) with wrap-around
     * to find the next enabled row. Scans at most N rows (full list length).
     * Returns `null` only when every row is disabled.
     */
    private findNextEnabled(fromIndex: number, direction: 1 | -1): number | null {
        const rows = this.flatRows();
        if (rows.length === 0) return null;

        let index = (((fromIndex + direction) % rows.length) + rows.length) % rows.length;
        let scanned = 0;

        while (scanned < rows.length) {
            if (!rows[index].disabled) return index;
            index = (((index + direction) % rows.length) + rows.length) % rows.length;
            scanned++;
        }

        return null; // All rows disabled.
    }
}
