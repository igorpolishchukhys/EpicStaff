import { CommonModule } from '@angular/common';
import { Component, inject, output } from '@angular/core';

import { AppSvgIconComponent } from '../../../shared/components/app-svg-icon/app-svg-icon.component';
import { UndoRedoService } from '../../services/undo-redo.service';

/**
 * Undo/redo toolbar panel.
 *
 * EST-10: The panel no longer calls undoRedoService.onUndo/onRedo directly.
 * Instead it emits `undoRequested` / `redoRequested` outputs so
 * FlowGraphComponent can execute the replay (which must also broadcast to
 * collaborators). `undoRedoPerformed` is kept for backward compat — the host
 * template binds `(undoRedoPerformed)="hasUnarrangedChanges.set(true)"`.
 */
@Component({
    selector: 'app-flow-action-panel',
    standalone: true,
    imports: [CommonModule, AppSvgIconComponent],
    templateUrl: './flow-action-panel.component.html',
    styleUrls: ['./flow-action-panel.component.scss'],
})
export class FlowActionPanelComponent {
    /** Emitted when the undo button is clicked. FlowGraphComponent handles replay. */
    readonly undoRequested = output<void>();
    /** Emitted when the redo button is clicked. FlowGraphComponent handles replay. */
    readonly redoRequested = output<void>();
    /**
     * Kept for backward compat — host template binds
     * `(undoRedoPerformed)="hasUnarrangedChanges.set(true)"`.
     */
    readonly undoRedoPerformed = output<void>();

    readonly actionIcons = [
        { icon: 'arrow-back-up', tooltip: 'Undo', action: 'undo' },
        { icon: 'arrow-forward-up', tooltip: 'Redo', action: 'redo' },
    ];

    private readonly undoRedoService = inject(UndoRedoService);

    readonly canUndo = this.undoRedoService.canUndo;
    readonly canRedo = this.undoRedoService.canRedo;

    isActionDisabled(action: string): boolean {
        if (action === 'undo') return !this.canUndo();
        if (action === 'redo') return !this.canRedo();
        return false;
    }

    handleAction(actionType: string): void {
        switch (actionType) {
            case 'undo':
                this.undoRequested.emit();
                this.undoRedoPerformed.emit();
                break;
            case 'redo':
                this.redoRequested.emit();
                this.undoRedoPerformed.emit();
                break;
            default:
                console.warn('Action not implemented:', actionType);
                break;
        }
    }
}
