import { DialogRef } from '@angular/cdk/dialog';
import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, inject, ViewChild } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';

import { AppSvgIconComponent } from '../../../shared/components/app-svg-icon/app-svg-icon.component';

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
                role="dialog"
                aria-modal="true"
                aria-label="Command palette"
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
                            placeholder="Search…"
                            autocomplete="off"
                            spellcheck="false"
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
                overflow: hidden;
                color: var(--color-text-primary, #d9d9de);
            }

            .palette-header {
                padding: 1rem 1rem;
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
        `,
    ],
})
export class CommandPaletteComponent implements AfterViewInit {
    @ViewChild('searchInput') private readonly searchInputRef!: ElementRef<HTMLInputElement>;

    private readonly dialogRef = inject(DialogRef);

    ngAfterViewInit(): void {
        this.searchInputRef.nativeElement.focus();
    }

    close(): void {
        this.dialogRef.close();
    }
}
