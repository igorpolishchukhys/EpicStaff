import { CreateNodeRequest } from './node-creation.types';

export enum EditorActionId {
    RunFlow = 'run-flow',
    Save = 'save',
    Undo = 'undo',
    Redo = 'redo',
    FitToScreen = 'fit-to-screen',
    OpenSettings = 'open-settings',
    OpenShortcuts = 'open-shortcuts',
}

export type PaletteResult =
    | { kind: 'create-node'; request: CreateNodeRequest }
    | { kind: 'action'; actionId: EditorActionId }
    | { kind: 'goto-node'; nodeId: string };

/**
 * Editor actions that mutate the graph, persist, or start a run. Viewers
 * (no flows:update permission / collaboration viewer role) must not be able
 * to invoke these. FitToScreen / OpenSettings / OpenShortcuts and goto-node
 * navigation stay available to viewers.
 */
export const MUTATING_EDITOR_ACTIONS: ReadonlySet<EditorActionId> = new Set([
    EditorActionId.RunFlow,
    EditorActionId.Save,
    EditorActionId.Undo,
    EditorActionId.Redo,
]);

/** Data passed into CommandPaletteComponent via the CDK dialog. */
export interface CommandPaletteData {
    /** Whether the current user may perform mutating actions. Snapshot of the editor's `canEdit`. */
    readonly canMutate: boolean;
}
