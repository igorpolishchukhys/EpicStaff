import { NgStyle } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { PresenceParticipant } from '../../../../../../services/collaboration/collab-message.model';
import { getParticipantColor } from './collab-colors';

const MAX_VISIBLE = 5;

export interface AvatarViewModel {
    userId: number;
    initials: string;
    color: string;
    label: string;
    isCurrentUser: boolean;
}

@Component({
    selector: 'app-presence-avatar-stack',
    standalone: true,
    imports: [NgStyle],
    templateUrl: './presence-avatar-stack.component.html',
    styleUrl: './presence-avatar-stack.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PresenceAvatarStackComponent {
    // --- Inputs ---
    readonly participants = input<PresenceParticipant[]>([]);
    readonly currentUserId = input<number | null>(null);

    // --- Computed ---

    /** Deduplicated participants — current user first, then others in first-appearance order. */
    private readonly deduplicatedParticipants = computed<PresenceParticipant[]>(() => {
        const all = this.participants();
        const meId = this.currentUserId();

        const seen = new Set<number>();
        const deduped: PresenceParticipant[] = [];

        // Current user first
        for (const p of all) {
            if (p.user_id === meId && !seen.has(p.user_id)) {
                seen.add(p.user_id);
                deduped.push(p);
            }
        }
        // Then others
        for (const p of all) {
            if (!seen.has(p.user_id)) {
                seen.add(p.user_id);
                deduped.push(p);
            }
        }

        return deduped;
    });

    /** Visible avatars capped at MAX_VISIBLE, mapped to view models. */
    readonly visibleAvatars = computed<AvatarViewModel[]>(() => {
        const meId = this.currentUserId();
        return this.deduplicatedParticipants()
            .slice(0, MAX_VISIBLE)
            .map((p) => this.buildViewModel(p, meId));
    });

    /** Count of participants that overflow beyond MAX_VISIBLE (after dedup). */
    readonly overflowCount = computed<number>(() => Math.max(0, this.deduplicatedParticipants().length - MAX_VISIBLE));

    // --- Private helpers ---

    private buildViewModel(participant: PresenceParticipant, currentUserId: number | null): AvatarViewModel {
        const isCurrentUser = participant.user_id === currentUserId;
        const displayName = participant.display_name;
        const initials = this.deriveInitials(displayName);
        const label = displayName
            ? isCurrentUser
                ? `${displayName} (you)`
                : displayName
            : isCurrentUser
              ? '(you)'
              : `User ${participant.user_id}`;

        return {
            userId: participant.user_id,
            initials,
            color: getParticipantColor(participant.user_id),
            label,
            isCurrentUser,
        };
    }

    private deriveInitials(displayName: string | null): string {
        if (!displayName) return '?';
        const parts = displayName.trim().split(/\s+/);
        if (parts.length >= 2) {
            return ((Array.from(parts[0])[0] ?? '') + (Array.from(parts[1])[0] ?? '')).toUpperCase();
        }
        return Array.from(parts[0]).slice(0, 2).join('').toUpperCase();
    }
}
