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
