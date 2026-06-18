import { NODE_COLORS, NODE_ICONS } from '../enums/node-config';
import { NodeType } from '../enums/node-type';
import { DEFAULT_NODE_DATA } from './default-node-data';

/**
 * Describes a single addable node type shown in the palette and context menu.
 * This is the single source of truth for what nodes users can create.
 */
export interface FlowGraphBlock {
    /** Human-readable display label. */
    label: string;
    /** The node type enum value. */
    type: NodeType;
    /** CSS class string for the icon (e.g. "ti ti-brand-python"). */
    icon: string;
    /** CSS color for the node accent. */
    color: string;
}

/**
 * Ordered list of all user-addable node types shown in the add-node UI.
 * Both the command palette and the right-click context menu consume this array.
 */
export const NODE_BLOCKS: readonly FlowGraphBlock[] = [
    {
        label: 'Python Code Node',
        type: NodeType.PYTHON,
        icon: NODE_ICONS[NodeType.PYTHON],
        color: NODE_COLORS[NodeType.PYTHON],
    },
    {
        label: 'File Extractor',
        type: NodeType.FILE_EXTRACTOR,
        icon: NODE_ICONS[NodeType.FILE_EXTRACTOR],
        color: NODE_COLORS[NodeType.FILE_EXTRACTOR],
    },
    {
        label: 'Audio to Text',
        type: NodeType.AUDIO_TO_TEXT,
        icon: NODE_ICONS[NodeType.AUDIO_TO_TEXT],
        color: NODE_COLORS[NodeType.AUDIO_TO_TEXT],
    },
    {
        label: 'End',
        type: NodeType.END,
        icon: NODE_ICONS[NodeType.END],
        color: NODE_COLORS[NodeType.END],
    },
    {
        label: 'Note',
        type: NodeType.NOTE,
        icon: NODE_ICONS[NodeType.NOTE],
        color: NODE_COLORS[NodeType.NOTE],
    },
    {
        label: 'Decision Table',
        type: NodeType.TABLE,
        icon: NODE_ICONS[NodeType.TABLE],
        color: NODE_COLORS[NodeType.TABLE],
    },
    {
        label: 'Webhook Trigger',
        type: NodeType.WEBHOOK_TRIGGER,
        icon: NODE_ICONS[NodeType.WEBHOOK_TRIGGER],
        color: NODE_COLORS[NodeType.WEBHOOK_TRIGGER],
    },
    {
        label: 'Telegram Trigger',
        type: NodeType.TELEGRAM_TRIGGER,
        icon: NODE_ICONS[NodeType.TELEGRAM_TRIGGER],
        color: NODE_COLORS[NodeType.TELEGRAM_TRIGGER],
    },
    {
        label: 'Schedule Trigger',
        type: NodeType.SCHEDULE_TRIGGER,
        icon: NODE_ICONS[NodeType.SCHEDULE_TRIGGER],
        color: NODE_COLORS[NodeType.SCHEDULE_TRIGGER],
    },
    {
        label: 'Code Agent',
        type: NodeType.CODE_AGENT,
        icon: NODE_ICONS[NodeType.CODE_AGENT],
        color: NODE_COLORS[NodeType.CODE_AGENT],
    },
] as const;

/**
 * Returns the canonical default `data` payload for a given node type.
 * Delegates to `DEFAULT_NODE_DATA` which is already the authoritative source
 * consumed by `NodeFactoryService`. Returns `null` for types with no default data.
 */
export function getDefaultNodeData(type: NodeType): unknown {
    const factory = DEFAULT_NODE_DATA[type];
    return factory ? factory() : null;
}
