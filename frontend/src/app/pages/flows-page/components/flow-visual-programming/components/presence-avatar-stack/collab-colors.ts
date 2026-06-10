/**
 * Ordered palette for collaboration presence avatars.
 * Values reference CSS custom properties defined in _variables.scss.
 * Index selection: palette[user_id % palette.length] — deterministic, no
 * coordination required across clients.
 *
 * The 7 variables used are all declared in src/styles/_variables.scss:
 *   --accent-color         #685fff  (purple)
 *   --color-ks-status-blue #48cbff  (blue)
 *   --color-nodes-flow-link #00bfa5 (teal)
 *   --color-ks-status-new  #2aba6b  (green)
 *   --color-ks-status-warning #ffcf00 (yellow)
 *   --color-ks-status-processing #ff8f3f (orange)
 *   --color-ks-status-failed #dc5b60 (red/pink)
 */
export const COLLAB_PARTICIPANT_PALETTE: readonly string[] = [
    'var(--accent-color)',
    'var(--color-ks-status-blue)',
    'var(--color-nodes-flow-link)',
    'var(--color-ks-status-new)',
    'var(--color-ks-status-warning)',
    'var(--color-ks-status-processing)',
    'var(--color-ks-status-failed)',
] as const;

export function getParticipantColor(userId: number): string {
    return COLLAB_PARTICIPANT_PALETTE[userId % COLLAB_PARTICIPANT_PALETTE.length];
}
