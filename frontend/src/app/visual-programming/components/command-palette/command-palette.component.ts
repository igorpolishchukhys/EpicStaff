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
import { CreateNodeRequest } from '../../core/models/node-creation.types';
import { FlowService } from '../../services/flow.service';

/** A block entry annotated with its disabled state for rendering. */
interface PaletteEntry extends FlowGraphBlock {
    disabled: boolean;
}

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
                aria-label="Add node"
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
                            placeholder="Search nodes…"
                            autocomplete="off"
                            spellcheck="false"
                            [formControl]="searchControl"
                            aria-label="Search nodes"
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
                    aria-label="Available node types"
                >
                    @for (entry of filteredEntries(); track entry.type; let i = $index) {
                        <li
                            class="node-item"
                            [class.highlighted]="i === highlightedIndex()"
                            [class.disabled]="entry.disabled"
                            [attr.id]="'palette-option-' + entry.type"
                            role="option"
                            [attr.aria-selected]="i === highlightedIndex()"
                            [attr.aria-disabled]="entry.disabled"
                            (click)="selectEntry(entry)"
                            (mouseenter)="!entry.disabled && highlightedIndex.set(i)"
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

                    @if (filteredEntries().length === 0) {
                        <li class="no-results">No nodes match "{{ searchControl.value }}"</li>
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

    readonly filteredEntries = computed<PaletteEntry[]>(() => {
        const query = this.querySignal() ?? '';
        const hasEnd = this.flowService.hasEndNode();

        if (query.trim().length === 0) {
            return NODE_BLOCKS.map((block) => ({
                ...block,
                disabled: block.type === NodeType.END && hasEnd,
            }));
        }

        const scored: { block: FlowGraphBlock; score: number }[] = [];
        for (const block of NODE_BLOCKS) {
            const score = fuzzyMatch(query, block.label);
            if (score !== null) {
                scored.push({ block, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);

        return scored.map(({ block }) => ({
            ...block,
            disabled: block.type === NodeType.END && hasEnd,
        }));
    });

    readonly activeDescendantId = computed<string | null>(() => {
        const entries = this.filteredEntries();
        const index = this.highlightedIndex();
        if (index < 0 || index >= entries.length) return null;
        return `palette-option-${entries[index].type}`;
    });

    // --- Private fields ---
    readonly searchControl = new FormControl('', { nonNullable: true });

    private readonly querySignal = toSignal(this.searchControl.valueChanges, {
        initialValue: '',
    });

    private readonly dialogRef = inject(DialogRef<CreateNodeRequest>);
    private readonly flowService = inject(FlowService);

    constructor() {
        // Reset highlight when the filtered list changes.
        // Use takeUntilDestroyed so this subscription is cleaned up automatically.
        this.searchControl.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
            this.highlightedIndex.set(0);
        });
    }

    // --- Lifecycle ---
    ngAfterViewInit(): void {
        this.searchInputRef.nativeElement.focus();
    }

    // --- Public methods ---

    onKeyDown(event: KeyboardEvent): void {
        const entries = this.filteredEntries();
        const current = this.highlightedIndex();

        switch (event.key) {
            case 'ArrowDown': {
                event.preventDefault();
                const next = this.findNextEnabled(entries, current, 1);
                if (next !== null) {
                    this.highlightedIndex.set(next);
                }
                break;
            }
            case 'ArrowUp': {
                event.preventDefault();
                const prev = this.findNextEnabled(entries, current, -1);
                if (prev !== null) {
                    this.highlightedIndex.set(prev);
                }
                break;
            }
            case 'Enter': {
                event.preventDefault();
                const entry = entries[current];
                if (entry && !entry.disabled) {
                    this.selectEntry(entry);
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

    selectEntry(entry: PaletteEntry): void {
        if (entry.disabled) {
            return;
        }
        const request: CreateNodeRequest = { type: entry.type };
        this.dialogRef.close(request);
    }

    close(): void {
        this.dialogRef.close();
    }

    // --- Private methods ---

    /**
     * Starting from `fromIndex`, walks in `direction` (+1 or -1) to find the
     * next enabled entry index. Returns `null` if none found.
     */
    private findNextEnabled(entries: PaletteEntry[], fromIndex: number, direction: 1 | -1): number | null {
        let index = fromIndex + direction;
        while (index >= 0 && index < entries.length) {
            if (!entries[index].disabled) {
                return index;
            }
            index += direction;
        }
        return null;
    }
}
