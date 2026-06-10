import { ChangeDetectionStrategy, Component, computed, input, Pipe, PipeTransform } from '@angular/core';

import { COLLAB_PARTICIPANT_PALETTE } from '../../../pages/flows-page/components/flow-visual-programming/components/presence-avatar-stack/collab-colors';
import { RemoteCursorState } from '../../services/collab-presentation.service';

// ---------------------------------------------------------------------------
// Inline pipe — declared before the component so the decorator can reference it
// ---------------------------------------------------------------------------

@Pipe({ name: 'colorForUserId', standalone: true, pure: true })
export class ColorForUserIdPipe implements PipeTransform {
    transform(userId: number): string {
        return COLLAB_PARTICIPANT_PALETTE[userId % COLLAB_PARTICIPANT_PALETTE.length];
    }
}

// ---------------------------------------------------------------------------
// Cursor layer component
// ---------------------------------------------------------------------------

/**
 * Renders remote-user cursor overlays inside the foblex `<f-canvas>`.
 *
 * Because this component is placed inside `<f-canvas>`, foblex's own CSS
 * transform (zoom + pan) is applied to the entire canvas element — so cursors
 * are automatically positioned in canvas (flow) coordinates with no extra math
 * required. (AC2)
 *
 * Selection outline approach: NOT rendered here. Each `FlowBaseNodeComponent`
 * receives a `remoteSelection` input and applies a CSS outline itself. This
 * avoids DOM rect lookups and integrates cleanly with the node host-class pattern.
 */
@Component({
    selector: 'app-collab-cursor-layer',
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        @for (entry of cursorEntries(); track entry.origin) {
            <div
                class="collab-cursor"
                [style.transform]="'translate(' + entry.state.x + 'px, ' + entry.state.y + 'px)'"
            >
                <!-- SVG pointer arrow in the user's presence color -->
                <svg
                    class="collab-cursor__pointer"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 24"
                    width="16"
                    height="24"
                    [attr.fill]="entry.state.userId | colorForUserId"
                >
                    <path d="M0 0 L0 20 L4.5 15.5 L7 20 L9 19 L6.5 14 L12 14 Z" />
                </svg>
                <!-- Name tag pill in the user's presence color -->
                <span
                    class="collab-cursor__label"
                    [style.background-color]="entry.state.userId | colorForUserId"
                >
                    {{ entry.state.displayName }}
                </span>
            </div>
        }
    `,
    styleUrl: './collab-cursor-layer.component.scss',
    imports: [ColorForUserIdPipe],
})
export class CollabCursorLayerComponent {
    /** Map of member-origin → cursor state, keyed by origin string. */
    readonly cursors = input.required<Map<string, RemoteCursorState>>();

    /** Converts the signal map to a flat array for the @for loop. */
    readonly cursorEntries = computed((): Array<{ origin: string; state: RemoteCursorState }> => {
        const result: Array<{ origin: string; state: RemoteCursorState }> = [];
        for (const [origin, state] of this.cursors()) {
            result.push({ origin, state });
        }
        return result;
    });
}
