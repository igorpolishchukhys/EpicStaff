import { Dialog } from '@angular/cdk/dialog';
import {
    afterNextRender,
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    computed,
    effect,
    ElementRef,
    EventEmitter,
    inject,
    Injector,
    Input,
    OnChanges,
    OnDestroy,
    OnInit,
    Output,
    output,
    signal,
    SimpleChanges,
    ViewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { IPoint, PointExtensions } from '@foblex/2d';
import {
    EFMarkerType,
    EFResizeHandleType,
    EFZoomDirection,
    F_CONNECTION_BUILDERS,
    FCanvasComponent,
    FConnectionContent,
    FConnectionGradient,
    FConnectionWaypoints,
    FCreateConnectionEvent,
    FCreateNodeEvent,
    FDragNodeStartEventData,
    FDragStartedEvent,
    FFlowComponent,
    FFlowModule,
    FReassignConnectionEvent,
    FSelectionChangeEvent,
    FZoomDirective,
    ICurrentSelection,
} from '@foblex/flow';
import { Subject } from 'rxjs';

import { PermissionsService } from '../../services/auth/permissions.service';
import {
    ConnectionAddedMessage,
    ConnectionRemovedMessage,
    NodeAddedMessage,
    NodeDeletedMessage,
} from '../../services/collaboration/collab-message.model';
import { CollaborationPresenceService } from '../../services/collaboration/collaboration-presence.service';
import { ToastService } from '../../services/notifications/toast.service';
import { AppSvgIconComponent } from '../../shared/components/app-svg-icon/app-svg-icon.component';
import { CollabCursorLayerComponent } from '../components/collab-cursor-layer/collab-cursor-layer.component';
import { CommandPaletteComponent } from '../components/command-palette/command-palette.component';
import { DomainDialogComponent } from '../components/domain-dialog/domain-dialog.component';
import { FlowActionPanelComponent } from '../components/flow-action-panel/flow-action-panel.component';
import { FlowBaseNodeComponent } from '../components/flow-base-node/flow-base-node.component';
import { FlowFilesButtonComponent } from '../components/flow-files-button/flow-files-button.component';
import { FlowGraphContextMenuComponent } from '../components/flow-graph-context-menu/flow-graph-context-menu.component';
import { FlowSettingsPanelComponent } from '../components/flow-settings-panel/flow-settings-panel.component';
import { FlowShortcutsButtonComponent } from '../components/flow-shortcuts-button/flow-shortcuts-button.component';
import { NodePanelShellComponent } from '../components/node-panels/node-panel-shell/node-panel-shell.component';
import { NodesSearchComponent } from '../components/nodes-search/nodes-search.component';
import { NoteEditDialogComponent } from '../components/note-edit-dialog/note-edit-dialog.component';
import { ProjectDialogComponent } from '../components/project-dialog/project-dialog.component';
import { MouseTrackerDirective } from '../core/directives/mouse-tracker.directive';
import { ShortcutListenerDirective } from '../core/directives/shortcut-listener.directive';
import { WaypointTooltipDirective } from '../core/directives/waypoint-tooltip.directive';
import { NodeType } from '../core/enums/node-type';
import { computeAutoArrangePositions } from '../core/helpers/auto-arrange.util';
import { BackwardArcPathBuilder, computeBackwardArcPoints } from '../core/helpers/backward-arc.path-builder';
import { getMinimapClassForNode } from '../core/helpers/get-minimap-class.util';
import {
    defineSourceTargetPair,
    generatePortsForNode,
    isBackwardConnection,
    isConnectionValid,
} from '../core/helpers/helpers';
import {
    findNearestFreePosition,
    getCollisionBounds,
    GRID_CELL_SIZE,
    resolveOverlapsForNode,
    snapPointToGrid,
} from '../core/helpers/node-placement.utils';
import { normalizeTableNodeSize } from '../core/helpers/node-size.util';
import {
    computeSegmentAvoidanceWaypoints,
    getConnectionIntersectingNodes,
    getPortPosition,
    normalizeConnectionWaypoints,
} from '../core/helpers/segment-avoidance.helper';
import {
    CommandPaletteData,
    EditorActionId,
    MUTATING_EDITOR_ACTIONS,
    PaletteResult,
} from '../core/models/command-palette.types';
import { ConnectionModel } from '../core/models/connection.model';
import { FlowModel } from '../core/models/flow.model';
import { GraphNoteModel, NodeModel, ProjectNodeModel, StartNodeModel } from '../core/models/node.model';
import { CreateNodeRequest } from '../core/models/node-creation.types';
import { CustomPortId } from '../core/models/port.model';
import {
    FlowOp,
    OpAddConnection,
    OpAddNode,
    OpDeleteNode,
    OpMoveNode,
    OpRemoveConnection,
    OpUpdateNodeData,
} from '../core/models/undo-redo-op.model';
import { ClipboardService } from '../services/clipboard.service';
import { CollabPresentationService } from '../services/collab-presentation.service';
import { FlowService } from '../services/flow.service';
import { FlowSettingsService } from '../services/flow-settings.service';
import { NodeFactoryService } from '../services/node-factory.service';
import { PanelLockService } from '../services/panel-lock.service';
import { SidePanelService } from '../services/side-panel.service';
import { UndoRedoService } from '../services/undo-redo.service';
import { createFlowConnection } from '../utils/connection.factory';
import { normalizeFlowPorts } from '../utils/load';

function waypointsEqual(a: IPoint[], b: IPoint[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
}

@Component({
    selector: 'app-flow-graph',
    templateUrl: './flow-graph.component.html',
    styleUrls: ['../styles/_variables.scss', './flow-graph.component.scss'],
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: { tabindex: '-1' },
    providers: [
        {
            provide: F_CONNECTION_BUILDERS,
            useFactory: (flowService: FlowService) => ({
                'backward-arc': new BackwardArcPathBuilder(() => flowService.nodes()),
            }),
            deps: [FlowService],
        },
    ],
    imports: [
        FFlowModule,
        FZoomDirective,
        FormsModule,
        FlowBaseNodeComponent,
        ShortcutListenerDirective,
        MouseTrackerDirective,
        FlowGraphContextMenuComponent,
        FlowActionPanelComponent,
        NodesSearchComponent,
        NodePanelShellComponent,
        FlowShortcutsButtonComponent,
        AppSvgIconComponent,
        FConnectionGradient,
        FConnectionContent,
        FConnectionWaypoints,
        WaypointTooltipDirective,
        FlowFilesButtonComponent,
        CollabCursorLayerComponent,
    ],
})
export class FlowGraphComponent implements OnInit, OnChanges, OnDestroy {
    @Input() flowState!: FlowModel;
    @Input() currentFlowId: number | null = null;
    @Input() flowName: string = '';
    @Input() initialNodeId: string | null = null;

    @Output() save = new EventEmitter<FlowModel>();
    readonly openShortcuts = output<DOMRect>();
    readonly runRequested = output<void>();

    @ViewChild(FFlowComponent, { static: false })
    private fFlowComponent!: FFlowComponent;

    @ViewChild(FCanvasComponent, { static: true })
    private fCanvasComponent!: FCanvasComponent;

    @ViewChild(FZoomDirective, { static: true })
    private fZoomDirective!: FZoomDirective;

    @ViewChild('nodePanelShell', { static: false })
    private nodePanelShell?: NodePanelShellComponent;

    @ViewChild('arrangeBtnRef') private arrangeBtnRef?: ElementRef<HTMLButtonElement>;

    @ViewChild('shortcutsAnchor') private shortcutsAnchorRef?: ElementRef<HTMLElement>;

    readonly GRID_CELL_SIZE = GRID_CELL_SIZE;
    protected readonly getMinimapClassForNode = getMinimapClassForNode;
    protected readonly eMarkerType = EFMarkerType;
    protected readonly CONNECTION_DELETE_BUTTON_POSITION = 0.56;
    protected readonly eResizeHandleType = EFResizeHandleType;
    protected readonly NodeType = NodeType;

    protected mouseCursorPosition: IPoint = { x: 0, y: 0 };
    protected contextMenuPosition = signal<IPoint>({ x: 0, y: 0 });
    protected isLoaded = signal(false);
    private arrangeAnimationId: number | null = null;
    private _arrangingLock = false;
    protected showContextMenu = signal(false);
    protected readonly hasUnarrangedChanges = signal(true);
    protected readonly isArranging = signal<boolean>(false);
    protected readonly flowSettings = inject(FlowSettingsService);

    private readonly permissionsService = inject(PermissionsService);

    /**
     * True when the current user has the 'update' permission on 'flows' AND the
     * server did not mark this collab session as read-only (viewer).
     *
     * Both gates must pass for edit affordances to be active:
     *  - org RBAC: the user's role allows flow updates
     *  - server viewer flag: the WS `self` frame did not set is_viewer=true
     *
     * This keeps canvas affordances coherent with the transport-level send guards
     * in CollaborationPresenceService (which also short-circuit on isViewer()).
     */
    protected readonly canEdit = computed(
        () => this.permissionsService.can('flows', 'update') && !this.collaborationPresenceService.isViewer()
    );

    /** Convenience inverse of canEdit — use in templates for @if(!canEdit()) guards. */
    protected readonly isViewer = computed(() => !this.canEdit());

    protected readonly nodeColorMap = computed<Map<string, string>>(() => {
        const map = new Map<string, string>();
        for (const node of this.flowService.nodes()) {
            map.set(node.id, node.color);
        }
        return map;
    });

    protected readonly backwardConnectionIds = computed<Set<string>>(() => {
        const nodes = this.flowService.nodes();
        const connections = this.flowService.visibleConnections();
        const ids = new Set<string>();

        for (const conn of connections) {
            if (isBackwardConnection(conn, nodes)) {
                ids.add(conn.id);
            }
        }

        return ids;
    });

    protected readonly sortedConnections = computed(() => {
        const backwardIds = this.backwardConnectionIds();
        const hiddenIds = this.hiddenConnectionIds();

        const connections = [...this.flowService.visibleConnections()].filter(
            (connection) => !hiddenIds.has(connection.id)
        );

        return connections.sort((a, b) => {
            const aBackward = backwardIds.has(a.id) ? 1 : 0;
            const bBackward = backwardIds.has(b.id) ? 1 : 0;

            return aBackward - bBackward;
        });
    });

    public hoveredNodeId = signal<string | null>(null);

    public getNodeZIndex(node: NodeModel): number {
        if (this.hoveredNodeId() === node.id) return 1000;
        return Math.max(2, 500 - Math.floor(Math.max(0, node.position?.y ?? 0) / 10));
    }

    private readonly destroy$ = new Subject<void>();
    private readonly userAdjustedConnectionIds = new Set<string>();
    private readonly previousBackwardConnectionIds = new Set<string>();
    private draggedNodeIds = new Set<string>();
    private draggingElements = new Set<string>();
    private isDragging = false;
    /** Pre-drag positions captured at drag-start, used to build the inverse move op at drag-end. */
    private readonly dragStartPositions = new Map<string, { x: number; y: number }>();
    protected readonly connectionRenderVersions = signal<Record<string, number>>({});
    private readonly hiddenConnectionIds = signal<Set<string>>(new Set<string>());

    protected readonly flowService = inject(FlowService);
    protected readonly sidePanelService = inject(SidePanelService);
    private readonly undoRedoService = inject(UndoRedoService);
    private readonly clipboardService = inject(ClipboardService);
    private readonly nodeFactory = inject(NodeFactoryService);
    private readonly cd = inject(ChangeDetectorRef);
    private readonly dialog = inject(Dialog);
    private readonly toastService = inject(ToastService);
    private readonly injector = inject(Injector);
    private readonly collaborationPresenceService = inject(CollaborationPresenceService);
    readonly collabPresentation = inject(CollabPresentationService);
    private readonly panelLockService = inject(PanelLockService);
    private readonly hostRef = inject(ElementRef<HTMLElement>);

    /** Ids of nodes currently being dragged by the local user — used to ignore echo moves. */
    private readonly locallyDraggingNodeIds = new Set<string>();
    /**
     * True while a remote structural op (add/delete node or connection) is being applied
     * from a collaboration message. Guards against re-emitting outbound ops for remote-
     * originated changes.
     */
    private applyingRemote = false;
    /** Timestamp of the last throttled node_moved op sent per node id, for ~50 ms trailing throttle. */
    private readonly lastMoveSentAt = new Map<string, number>();
    /** Timestamp of last cursor op sent, for ~40 ms trailing throttle. */
    private lastCursorSentAt = 0;

    /**
     * Derived computed: backendNodeId → {color, displayName} for remote selections.
     * Consumed in the template to pass `remoteSelection` to each node.
     */
    protected readonly remoteNodeSelectionMap = computed(() => this.collabPresentation.nodeSelectionMap());

    /**
     * Derived computed: backendNodeId → {color, displayName} for remote panel locks.
     * Excludes the lock held by the local user (that node is open locally).
     * Consumed in the template to pass `remoteLock` to each node.
     */
    protected readonly remoteNodeLockMap = computed((): Map<number, { color: string; displayName: string }> => {
        const result = new Map<number, { color: string; displayName: string }>();
        const participants = this.collaborationPresenceService.participants();
        for (const [nodeId, entry] of this.panelLockService.locks()) {
            // Skip locks held by this client.
            const selfId = this.collaborationPresenceService.selfMemberId();
            if (selfId !== null && entry.memberId === selfId) {
                continue;
            }
            const displayName = this.collabPresentation.resolveDisplayName(entry.userId, participants);
            const color = this.collabPresentation.getColorForUserId(entry.userId);
            result.set(nodeId, { color, displayName });
        }
        return result;
    });

    constructor() {
        // Subscribe to remote cursor moves — filter self-echoes, guard flow_id.
        this.collaborationPresenceService.remoteCursor$.pipe(takeUntilDestroyed()).subscribe((msg) => {
            if (msg.origin === this.collaborationPresenceService.selfMemberId()) {
                return;
            }
            if (msg.flow_id !== this.currentFlowId) {
                return;
            }
            const participants = this.collaborationPresenceService.participants();
            const displayName = this.collabPresentation.resolveDisplayName(msg.user_id, participants);
            this.collabPresentation.upsertCursor(msg.origin, msg.x, msg.y, msg.user_id, displayName);
        });

        // Subscribe to remote selection changes — filter self-echoes, guard flow_id.
        this.collaborationPresenceService.remoteSelection$.pipe(takeUntilDestroyed()).subscribe((msg) => {
            if (msg.origin === this.collaborationPresenceService.selfMemberId()) {
                return;
            }
            if (msg.flow_id !== this.currentFlowId) {
                return;
            }
            const participants = this.collaborationPresenceService.participants();
            const displayName = this.collabPresentation.resolveDisplayName(msg.user_id, participants);
            this.collabPresentation.setSelection(msg.origin, new Set(msg.node_ids), msg.user_id, displayName);
        });

        // Prune stale cursors/selections when participants list changes.
        effect(() => {
            const participants = this.collaborationPresenceService.participants();
            const liveIds = new Set(participants.map((p) => p.user_id));
            this.collabPresentation.pruneToUsers(liveIds);
        });

        // Lock denied: rollback — close the open panel without saving if the denied
        // node is the one currently open, then notify the user who holds the lock.
        this.collaborationPresenceService.lockDenied$.pipe(takeUntilDestroyed()).subscribe((msg) => {
            const openNode = this.sidePanelService.selectedNode();
            if (openNode !== null && openNode.backendId === msg.node_id) {
                // Close without saving: clear the selection directly (bypasses autosave).
                this.sidePanelService.setSelectedNodeId(null);

                const participants = this.collaborationPresenceService.participants();
                const holderName = this.collabPresentation.resolveDisplayName(msg.holder_user_id, participants);
                this.toastService.error(`Node is locked by ${holderName}`);
            }
        });

        // Involuntary lock loss (server auto-released — e.g. disconnect/timeout):
        // close the open panel for that node without saving and warn the user.
        // Unsaved edits are intentionally discarded (last-write-wins) — the server
        // is already rejecting this client's writes for the lost lock.
        this.panelLockService.lockLost$.pipe(takeUntilDestroyed()).subscribe((nodeId) => {
            const openNode = this.sidePanelService.selectedNode();
            if (openNode !== null && openNode.backendId === nodeId) {
                this.sidePanelService.closePanelOnLockLoss();
                this.toastService.warning('Your editing lock was released because your connection dropped');
            }
        });

        // Remote node data update: apply to local flow state.
        this.collaborationPresenceService.remoteNodeDataUpdate$.pipe(takeUntilDestroyed()).subscribe((msg) => {
            if (msg.origin === this.collaborationPresenceService.selfMemberId()) {
                return;
            }
            this.applyRemoteNodeDataUpdate(msg.node_id, msg.node_name, msg.data);
        });
    }

    public ngOnInit(): void {
        this.applyIncomingFlowState(this.flowState);
        if (this.initialNodeId) {
            this.openNodePanel(this.initialNodeId);
        }
    }

    public ngOnChanges(changes: SimpleChanges): void {
        if (changes['flowState'] && !changes['flowState'].firstChange) {
            this.applyIncomingFlowState(this.flowState);
        }
        if (changes['initialNodeId'] && changes['initialNodeId'].currentValue) {
            this.openNodePanel(changes['initialNodeId'].currentValue);
        }
    }

    public ngOnDestroy(): void {
        if (this.arrangeAnimationId !== null) {
            cancelAnimationFrame(this.arrangeAnimationId);
            this.arrangeAnimationId = null;
        }
        // Abort any open batch whether the rAF was still running or the animation
        // completed but the post-animation setTimeout(0) hasn't fired yet.
        // _arrangingLock stays true for the entire arrange cycle (rAF + setTimeout),
        // so it is the reliable sentinel for "batch is open".
        if (this._arrangingLock) {
            this.undoRedoService.abortBatch();
            this._arrangingLock = false;
        }
        this.destroy$.next();
        this.destroy$.complete();
        this.collabPresentation.clear();
        this.panelLockService.clear();
    }

    public onInitialized(): void {
        this.isLoaded.set(true);
        setTimeout(() => {
            this.rerouteSegmentConnections();
            this.fCanvasComponent.fitToScreen({ x: 200, y: 100 }, false);
            this.cd.detectChanges();
        }, 0);
    }

    public onReassignConnection(event: FReassignConnectionEvent): void {
        if (!this.canEdit()) {
            return;
        }

        this.hasUnarrangedChanges.set(true);
        if (!event.newTargetId && !event.newSourceId) {
            console.warn('No new target or source provided for reassignment');
            return;
        }

        const existingConnection = this.flowService.connections().find((conn) => conn.id === event.connectionId);

        if (!existingConnection) {
            console.warn('Connection not found for reassignment:', event.connectionId);
            return;
        }

        const newSourcePortId = event.newSourceId || existingConnection.sourcePortId;
        const newTargetPortId = event.newTargetId || existingConnection.targetPortId;

        if (!isConnectionValid(newSourcePortId as CustomPortId, newTargetPortId as CustomPortId)) {
            console.warn('New connection is invalid. Reassignment aborted.');
            this.toastService.warning('Cannot reassign connection: Invalid port combination', 5000, 'bottom-right');
            return;
        }

        const newSourceNodeId = newSourcePortId.split('_')[0];
        const newTargetNodeId = newTargetPortId.split('_')[0];

        const updatedConnection = createFlowConnection(
            newSourceNodeId,
            newTargetNodeId,
            newSourcePortId as CustomPortId,
            newTargetPortId as CustomPortId
        );

        // Record as a batch: remove old + add new (single undoable gesture).
        this.undoRedoService.beginBatch();
        this.undoRedoService.recordOp({
            kind: 'remove_connection',
            connection: existingConnection,
        } satisfies OpRemoveConnection);
        this.flowService.removeConnection(event.connectionId);
        this.undoRedoService.recordOp({
            kind: 'add_connection',
            connection: updatedConnection,
        } satisfies OpAddConnection);
        this.flowService.addConnection(updatedConnection);
        this.undoRedoService.endBatch();

        this.toastService.success('Connection reassigned successfully', 3000, 'bottom-right');
    }

    public onConnectionAdded(event: FCreateConnectionEvent): void {
        if (!this.canEdit()) {
            return;
        }

        this.hasUnarrangedChanges.set(true);

        const { fOutputId, fInputId } = event;

        if (!fInputId) {
            console.warn('Connection event received without an input ID:', event);
            return;
        }

        if (!isConnectionValid(fOutputId as CustomPortId, fInputId as CustomPortId)) {
            console.warn('Connection is invalid and will not be added:', fOutputId, fInputId);
            return;
        }

        const pair = defineSourceTargetPair(fOutputId as CustomPortId, fInputId as CustomPortId);
        if (!pair) {
            console.warn('Failed to define source-target pair for ports:', fOutputId, fInputId);
            return;
        }

        const currentConnections = this.flowService.connections();

        const isDuplicate = currentConnections.some(
            (conn) => conn.sourcePortId === pair.sourcePortId && conn.targetPortId === pair.targetPortId
        );
        if (isDuplicate) {
            console.warn('Duplicate connection detected, ignoring:', `${pair.sourcePortId}+${pair.targetPortId}`);
            return;
        }

        const sourceNodeId = pair.sourcePortId.split('_')[0];
        const targetNodeId = pair.targetPortId.split('_')[0];

        const newConnection = createFlowConnection(
            sourceNodeId,
            targetNodeId,
            pair.sourcePortId as CustomPortId,
            pair.targetPortId as CustomPortId
        );

        this.undoRedoService.recordOp({
            kind: 'add_connection',
            connection: newConnection,
        } satisfies OpAddConnection);
        this.flowService.addConnection(newConnection);

        const nodes = this.flowService.nodes();
        const intersects = getConnectionIntersectingNodes(newConnection, nodes);

        const newConnTargetNode = nodes.find((n) => n.id === newConnection.targetNodeId);
        const newConnTargetPort = newConnTargetNode?.ports?.find((p) => p.id === newConnection.targetPortId);
        const isTableInTarget =
            newConnTargetNode?.type === NodeType.TABLE && newConnTargetPort?.id?.includes('table-in');

        if (intersects.length > 0 || isTableInTarget) {
            const avoidWaypoints = computeSegmentAvoidanceWaypoints(newConnection, nodes);
            if (avoidWaypoints) {
                const normalizedWaypoints = this.normalizeWaypointsForConnection(newConnection, avoidWaypoints);
                this.flowService.updateConnectionWaypoints(newConnection.id, normalizedWaypoints);
                this.bumpConnectionRenderVersion(newConnection.id);
            }
        }

        if (!this.applyingRemote) {
            const sourceNode = this.flowService.nodes().find((n) => n.id === sourceNodeId);
            const targetNode = this.flowService.nodes().find((n) => n.id === targetNodeId);
            this.collaborationPresenceService.sendConnectionAdd({
                connection_id: newConnection.id,
                source_node_key: sourceNode ? this.nodeKey(sourceNode) : sourceNodeId,
                target_node_key: targetNode ? this.nodeKey(targetNode) : targetNodeId,
                source_port_id: newConnection.sourcePortId,
                target_port_id: newConnection.targetPortId,
                connection: newConnection,
            });
        }
    }

    public onCopy(): void {
        if (this.isDialogOpen()) {
            return;
        }

        const selections: ICurrentSelection = this.fFlowComponent.getSelection();
        this.clipboardService.copy(selections);
    }

    public onPaste(): void {
        if (!this.canEdit()) {
            return;
        }

        this.hasUnarrangedChanges.set(true);
        if (this.isDialogOpen()) {
            return;
        }

        const pastePosition = this.mouseCursorPosition
            ? snapPointToGrid(this.toFlowPosition(this.mouseCursorPosition))
            : { x: 0, y: 0 };

        const { newNodes, newConnections } = this.clipboardService.paste(pastePosition);
        const placedNodes: NodeModel[] = [];
        const existingBeforePaste = this.flowService.nodes().filter((n) => !newNodes.some((p) => p.id === n.id));

        // Batch the entire paste as a single undoable gesture.
        this.undoRedoService.beginBatch();

        for (const node of newNodes) {
            const safePosition = findNearestFreePosition(snapPointToGrid(node.position), getCollisionBounds(node), [
                ...existingBeforePaste,
                ...placedNodes,
            ]);

            const updatedNode = { ...node, position: safePosition };
            this.undoRedoService.recordOp({
                kind: 'add_node',
                node: updatedNode,
            } satisfies OpAddNode);
            this.flowService.updateNode(updatedNode);
            placedNodes.push(updatedNode);
        }

        for (const conn of newConnections) {
            this.undoRedoService.recordOp({
                kind: 'add_connection',
                connection: conn,
            } satisfies OpAddConnection);
        }

        this.undoRedoService.endBatch();

        const newNodeIds = newNodes.map((node) => node.id);
        const newConnectionIds = newConnections.map((conn) => conn.id);

        setTimeout(() => {
            this.fFlowComponent.select(newNodeIds, newConnectionIds);
        }, 0);
    }

    public onUndo(): void {
        if (this.isDialogOpen()) {
            return;
        }

        const batch = this.undoRedoService.popUndo();
        if (!batch) {
            return;
        }

        this.hasUnarrangedChanges.set(true);
        this.replayOps(batch.inverse);
    }

    public onRedo(): void {
        if (this.isDialogOpen()) {
            return;
        }

        const batch = this.undoRedoService.popRedo();
        if (!batch) {
            return;
        }

        this.hasUnarrangedChanges.set(true);
        this.replayOps(batch.forward);
    }

    public onDelete(): void {
        if (!this.canEdit()) {
            return;
        }

        this.hasUnarrangedChanges.set(true);
        if (this.isDialogOpen()) {
            return;
        }

        const selections: ICurrentSelection = this.fFlowComponent.getSelection();
        this.deleteSelections(selections);
    }

    public onDeleteNode(node: NodeModel): void {
        if (!this.canEdit()) {
            return;
        }

        this.hasUnarrangedChanges.set(true);
        this.deleteSelections({
            fNodeIds: [node.id],
            fGroupIds: [],
            fConnectionIds: [],
        });
    }

    public onDeleteConnection(event: MouseEvent, connectionId: string): void {
        event.preventDefault();
        event.stopPropagation();

        if (!this.canEdit()) {
            return;
        }

        this.hasUnarrangedChanges.set(true);
        if (this.isDialogOpen()) {
            return;
        }

        this.deleteSelections({
            fNodeIds: [],
            fGroupIds: [],
            fConnectionIds: [connectionId],
        });
    }

    protected onWaypointsChanged(connectionId: string, waypoints: IPoint[]): void {
        const connection = this.flowService.connections().find((c) => c.id === connectionId);
        if (!connection) return;

        const existingCount = connection.waypoints?.length ?? 0;
        if (waypoints.length > existingCount) {
            this.userAdjustedConnectionIds.add(connectionId);
            this.flowService.updateConnectionWaypoints(connectionId, waypoints, true);
            return;
        }

        const normalizedWaypoints = this.normalizeWaypointsForConnection(connection, waypoints);

        if (normalizedWaypoints.length > 0) {
            this.userAdjustedConnectionIds.add(connectionId);
        } else {
            this.userAdjustedConnectionIds.delete(connectionId);
        }

        const isSameElements =
            normalizedWaypoints.length === waypoints.length && normalizedWaypoints.every((p, i) => p === waypoints[i]);

        this.flowService.updateConnectionWaypoints(
            connectionId,
            isSameElements ? waypoints : normalizedWaypoints,
            normalizedWaypoints.length > 0
        );
    }

    public onNodeDroppedFromPanel(event: FCreateNodeEvent): void {
        this.hasUnarrangedChanges.set(true);
        if (!event.data || typeof event.data !== 'object') {
            return;
        }

        const normalizedNode = this.ensureNodeSize(event.data as NodeModel);

        const updatedNode: NodeModel = {
            ...normalizedNode,
            position: this.findNearestFreePosition(
                {
                    x: this.snapToGrid(event.rect.x),
                    y: this.snapToGrid(event.rect.y),
                },
                this.getCollisionBounds(normalizedNode),
                this.flowService.nodes()
            ),
        };
        this.flowService.updateNode(updatedNode);

        if (!this.applyingRemote) {
            this.collaborationPresenceService.sendNodeAdd({
                node_key: this.nodeKey(updatedNode),
                node: updatedNode,
            });
        }
    }

    public onContextMenu(event: MouseEvent): void {
        event.preventDefault();
        if (!this.canEdit()) {
            return;
        }
        this.contextMenuPosition.set({ x: event.clientX, y: event.clientY });
        this.showContextMenu.set(true);
    }

    public onCloseContextMenu(): void {
        this.showContextMenu.set(false);
    }

    public onAddNodeFromContextMenu(event: CreateNodeRequest): void {
        if (!this.canEdit()) {
            this.showContextMenu.set(false);
            return;
        }

        this.hasUnarrangedChanges.set(true);
        this.showContextMenu.set(false);

        this.createNodeAt(
            event,
            PointExtensions.initialize(this.contextMenuPosition().x, this.contextMenuPosition().y)
        );
    }

    public onOpenNodePanel(node: NodeModel): void {
        if (this.sidePanelService.selectedNodeId() === node.id) {
            return;
        }

        if (node.type === NodeType.NOTE) {
            const noteNode = node as GraphNoteModel;

            const dialogRef = this.dialog.open(NoteEditDialogComponent, {
                data: { node: noteNode },
                disableClose: true,
            });

            dialogRef.closed.subscribe((result: unknown) => {
                if (
                    result !== null &&
                    typeof result === 'object' &&
                    'content' in result &&
                    typeof (result as { content?: unknown }).content !== 'undefined'
                ) {
                    const content = (result as { content?: unknown }).content;
                    if (typeof content !== 'string') return;

                    const updatedNode: GraphNoteModel = {
                        ...noteNode,
                        data: {
                            ...noteNode.data,
                            content,
                        },
                    };

                    this.flowService.updateNode(updatedNode);
                    this.cd.detectChanges();
                }
            });
        } else if (node.type === NodeType.START) {
            const startNode = node as StartNodeModel;
            const startNodeInitialState = startNode.data?.initialState || {};

            const dialogRef = this.dialog.open(DomainDialogComponent, {
                disableClose: true,
                width: '1000px',
                height: '800px',
                maxWidth: '90vw',
                maxHeight: '90vh',
                panelClass: 'domain-dialog-panel',
                backdropClass: 'domain-dialog-backdrop',
                data: {
                    initialData: startNodeInitialState,
                },
            });

            dialogRef.closed.subscribe((result: unknown) => {
                if (result !== null && typeof result === 'object' && result !== undefined) {
                    this.updateStartNodeInitialState(result as Record<string, unknown>);
                }
            });
        } else {
            const selected = this.sidePanelService.trySelectNode(node);
            if (!selected && typeof node.backendId === 'number') {
                const holder = this.panelLockService.lockedByOther(node.backendId);
                if (holder !== null) {
                    const participants = this.collaborationPresenceService.participants();
                    const holderName = this.collabPresentation.resolveDisplayName(holder.userId, participants);
                    this.toastService.error(`Node is being edited by ${holderName}`);
                }
            }
        }
    }

    public onNodePanelSaved(updatedNode: NodeModel): void {
        const normalizedNode = normalizeTableNodeSize(updatedNode);
        this.flowService.updateNode(normalizedNode);
        const movedNodeIds = this.resolveTableOverlaps(normalizedNode);

        // Broadcast data change to collaborators before clearing the selection
        // (which triggers lock release).
        if (typeof normalizedNode.backendId === 'number') {
            this.collaborationPresenceService.sendNodeDataUpdate({
                node_id: normalizedNode.backendId,
                node_name: normalizedNode.node_name,
                data: normalizedNode.data as Record<string, unknown>,
            });
        }

        this.sidePanelService.clearSelection();

        setTimeout(() => {
            this.rerouteSegmentConnections();

            const affectedNodeIds = new Set<string>([normalizedNode.id, ...movedNodeIds]);

            for (const conn of this.flowService.connections()) {
                if (affectedNodeIds.has(conn.sourceNodeId) || affectedNodeIds.has(conn.targetNodeId)) {
                    this.bumpConnectionRenderVersion(conn.id);
                }
            }

            this.cd.detectChanges();
        }, 0);
    }

    public onNodePanelAutosaved(updatedNode: NodeModel): void {
        const normalizedNode = normalizeTableNodeSize(updatedNode);
        this.flowService.updateNode(normalizedNode);
        const movedNodeIds = this.resolveTableOverlaps(normalizedNode);

        // Broadcast autosave data to collaborators.
        if (typeof normalizedNode.backendId === 'number') {
            this.collaborationPresenceService.sendNodeDataUpdate({
                node_id: normalizedNode.backendId,
                node_name: normalizedNode.node_name,
                data: normalizedNode.data as Record<string, unknown>,
            });
        }

        setTimeout(() => {
            this.rerouteSegmentConnections();

            const affectedNodeIds = new Set<string>([normalizedNode.id, ...movedNodeIds]);

            for (const conn of this.flowService.connections()) {
                if (affectedNodeIds.has(conn.sourceNodeId) || affectedNodeIds.has(conn.targetNodeId)) {
                    this.bumpConnectionRenderVersion(conn.id);
                }
            }

            this.cd.detectChanges();
        }, 0);
    }

    public commitSidePanelToFlow(): void {
        const updatedNode = this.nodePanelShell?.captureCurrentNodeState();
        if (updatedNode) {
            this.flowService.updateNode(updatedNode);
        }
    }

    public emitSave(): void {
        if (this.nodePanelShell?.hasPanelInstance()) {
            const updatedNode = this.nodePanelShell.captureCurrentNodeState();
            if (updatedNode === null) {
                return;
            }
            this.flowService.updateNode(updatedNode);
        }
        this.save.emit(this.flowService.getFlowState());
    }

    public onNodeSizeChanged(event: { width: number; height: number }, node: NodeModel): void {
        const updatedNode = {
            ...node,
            size: {
                width: event.width,
                height: event.height,
            },
        };

        this.undoRedoService.recordOp({
            kind: 'update_node_data',
            previousNode: node,
            updatedNode,
        } satisfies OpUpdateNodeData);

        this.flowService.updateNode(updatedNode);
    }

    public onDragStarted(event: FDragStartedEvent): void {
        if (!this.canEdit()) {
            return;
        }
        this.isDragging = true;
        this.draggingElements.clear();
        // Capture pre-drag positions so we can build the inverse move op at drag end.
        this.dragStartPositions.clear();

        const dragData = event.data as FDragNodeStartEventData | undefined;
        if (dragData?.fNodeIds) {
            const nodes = this.flowService.nodes();
            dragData.fNodeIds.forEach((id: string) => {
                this.draggingElements.add(id);
                this.locallyDraggingNodeIds.add(id);
                const node = nodes.find((n) => n.id === id);
                if (node) {
                    this.dragStartPositions.set(id, { x: node.position.x, y: node.position.y });
                }
            });
        }

        // Begin a batch so the entire multi-node drag is one undo entry.
        this.undoRedoService.beginBatch();
    }

    private rerouteSegmentConnections(): void {
        const nodes = this.flowService.nodes();
        const connections = this.flowService.connections();
        const backwardIds = this.backwardConnectionIds();

        for (const conn of connections) {
            const wasBackward = this.previousBackwardConnectionIds.has(conn.id);
            const isBackward = backwardIds.has(conn.id);
            const changedFromBackwardToForward = wasBackward && !isBackward;

            if (isBackward) {
                if (this.userAdjustedConnectionIds.has(conn.id)) continue;

                const bwSource = nodes.find((n) => n.id === conn.sourceNodeId);
                const bwTarget = nodes.find((n) => n.id === conn.targetNodeId);
                if (!bwSource || !bwTarget) continue;

                const bwSourcePort = bwSource.ports?.find((p) => p.id === conn.sourcePortId);
                const bwTargetPort = bwTarget.ports?.find((p) => p.id === conn.targetPortId);

                const bwSourcePt = getPortPosition(bwSource, bwSourcePort);
                const bwTargetPt = getPortPosition(bwTarget, bwTargetPort);

                const arcPts = computeBackwardArcPoints(bwSourcePt, bwTargetPt, undefined, nodes);
                const newWaypoint = {
                    x: (arcPts[1].x + arcPts[4].x) / 2,
                    y: arcPts[2].y,
                };

                const existing = conn.waypoints?.[0];
                const changed =
                    !existing ||
                    Math.abs(existing.y - newWaypoint.y) > 0.5 ||
                    Math.abs(existing.x - newWaypoint.x) > 0.5;

                if (changed) {
                    this.flowService.updateConnectionWaypoints(conn.id, [newWaypoint]);
                    this.bumpConnectionRenderVersion(conn.id);
                }

                continue;
            }

            if (this.userAdjustedConnectionIds.has(conn.id)) continue;

            const MAX_ATTEMPTS = 3;
            let current = this.flowService.connections().find((c) => c.id === conn.id);
            if (!current) continue;

            const currentConnection = current;
            const currentIntersections = getConnectionIntersectingNodes(currentConnection, nodes);

            if (currentIntersections.length === 0) {
                const rerouteTargetNode = nodes.find((n) => n.id === currentConnection.targetNodeId);
                const rerouteTargetPort = rerouteTargetNode?.ports?.find(
                    (p) => p.id === currentConnection.targetPortId
                );
                const isTableInConn =
                    rerouteTargetNode?.type === NodeType.TABLE && rerouteTargetPort?.id?.includes('table-in');

                if (
                    !changedFromBackwardToForward &&
                    !isTableInConn &&
                    (!currentConnection.waypoints || currentConnection.waypoints.length === 0)
                ) {
                    continue;
                }

                const restoreResult = computeSegmentAvoidanceWaypoints(
                    currentConnection,
                    nodes,
                    changedFromBackwardToForward
                        ? undefined
                        : currentConnection.waypoints?.length
                          ? currentConnection.waypoints
                          : undefined
                );

                if (restoreResult !== null) {
                    const normalizedRestore = this.normalizeWaypointsForConnection(currentConnection, restoreResult);

                    if (!waypointsEqual(currentConnection.waypoints ?? [], normalizedRestore)) {
                        this.flowService.updateConnectionWaypoints(currentConnection.id, normalizedRestore);
                        this.bumpConnectionRenderVersion(currentConnection.id);
                    }
                }

                continue;
            }

            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                const waypoints = computeSegmentAvoidanceWaypoints(
                    current,
                    nodes,
                    changedFromBackwardToForward ? undefined : current.waypoints
                );

                if (waypoints === null) break;

                const normalizedWaypoints = this.normalizeWaypointsForConnection(current, waypoints);
                if (waypointsEqual(current.waypoints ?? [], normalizedWaypoints)) break;

                this.flowService.updateConnectionWaypoints(current.id, normalizedWaypoints);
                this.bumpConnectionRenderVersion(current.id);
                current = { ...current, waypoints: normalizedWaypoints };
            }
        }

        this.previousBackwardConnectionIds.clear();

        for (const id of backwardIds) {
            this.previousBackwardConnectionIds.add(id);
        }
    }

    public onDragEnded(): void {
        const autoAlignedNodeIds = new Set<string>();

        for (const id of this.draggedNodeIds) {
            const currentNodes = this.flowService.nodes();
            const current = currentNodes.find((n) => n.id === id);
            if (!current) continue;

            const otherNodes = currentNodes.filter((n) => n.id !== id);
            const freePos = this.findNearestFreePosition(
                current.position,
                this.getCollisionBounds(current),
                otherNodes
            );

            if (freePos.x !== current.position.x || freePos.y !== current.position.y) {
                this.flowService.updateNode({ ...current, position: freePos });
                autoAlignedNodeIds.add(id);
            }

            // Send one final authoritative op with the collision-snapped position.
            if (typeof current.backendId === 'number') {
                const finalPos =
                    freePos.x !== current.position.x || freePos.y !== current.position.y ? freePos : current.position;
                this.collaborationPresenceService.sendNodeMove({
                    node_id: current.backendId,
                    x: finalPos.x,
                    y: finalPos.y,
                });
                this.lastMoveSentAt.delete(id);
            }
        }

        // Record a move op for each dragged node (from pre-drag position to final position).
        // Uses captured dragStartPositions and current post-snap positions.
        const currentNodes = this.flowService.nodes();
        for (const id of this.draggedNodeIds) {
            const from = this.dragStartPositions.get(id);
            const current = currentNodes.find((n) => n.id === id);
            if (!from || !current) continue;
            // Only record if the position actually changed.
            if (from.x !== current.position.x || from.y !== current.position.y) {
                this.undoRedoService.recordOp({
                    kind: 'move_node',
                    nodeId: id,
                    fromPosition: from,
                    toPosition: { x: current.position.x, y: current.position.y },
                } satisfies OpMoveNode);
            }
        }
        this.dragStartPositions.clear();

        // End the drag batch started in onDragStarted.
        this.undoRedoService.endBatch();

        this.draggedNodeIds.clear();

        // Release drag lock after the final ops are sent so inbound self-echoes
        // (which will arrive asynchronously) are treated as idempotent.
        for (const id of this.locallyDraggingNodeIds) {
            this.locallyDraggingNodeIds.delete(id);
        }

        setTimeout(() => {
            this.isDragging = false;
            this.draggingElements.clear();

            if (autoAlignedNodeIds.size > 0) {
                this.syncAfterAutoAlign(autoAlignedNodeIds);
            } else {
                this.rerouteSegmentConnections();
                this.cd.detectChanges();
                this.fFlowComponent?.redraw();
            }
        }, 100);
    }

    public onNodePositionChanged(newPos: IPoint, node: NodeModel): void {
        this.hasUnarrangedChanges.set(true);
        this.draggedNodeIds.add(node.id);

        const snappedX = this.snapToGrid(newPos.x);
        const snappedY = this.snapToGrid(newPos.y);

        const updatedNode = {
            ...node,
            position: { x: snappedX, y: snappedY },
        };

        this.flowService.updateNode(updatedNode);

        // Send throttled collaboration op (~50 ms trailing throttle via timestamp check).
        if (typeof node.backendId === 'number') {
            const now = Date.now();
            const lastSent = this.lastMoveSentAt.get(node.id) ?? 0;
            if (now - lastSent >= 50) {
                this.lastMoveSentAt.set(node.id, now);
                this.collaborationPresenceService.sendNodeMove({
                    node_id: node.backendId,
                    x: snappedX,
                    y: snappedY,
                });
            }
        }
    }

    /**
     * Applies a single remote node-move operation.  Resolves the backend id to
     * the local node, skips if the node is currently being dragged by the local
     * user, then updates the canvas.
     */
    public applyRemoteNodeMove(backendNodeId: number, position: { x: number; y: number }): void {
        const node = this.flowService.nodes().find((n) => n.backendId === backendNodeId);
        if (!node) {
            return;
        }
        if (this.locallyDraggingNodeIds.has(node.id)) {
            return;
        }
        this.flowService.applyRemotePosition(node.id, position);
        this.cd.detectChanges();
        this.fFlowComponent?.redraw();
    }

    /**
     * Bulk-applies document state positions (called once after the flow loads).
     * Skips nodes currently being dragged locally; triggers one redraw at the end.
     *
     * When the snapshot carries schema_version >= 2 (nodes / connections / tombstones),
     * also reconciles structural additions and removals:
     *  - adds nodes present in snapshot but missing locally
     *  - adds connections whose endpoints are now locally present but connection is missing
     *  - removes anything recorded in tombstones
     */
    public applyDocumentState(snapshot: {
        positions: Record<string, { x: number; y: number }>;
        schema_version?: number;
        nodes?: Record<string, unknown>;
        connections?: Record<
            string,
            {
                source_node_key: string;
                target_node_key: string;
                source_port_id: string;
                target_port_id: string;
                connection: unknown;
            }
        >;
        tombstones?: Record<string, string>;
    }): void {
        const {
            positions,
            schema_version,
            nodes: snapshotNodes,
            connections: snapshotConnections,
            tombstones,
        } = snapshot;

        // --- Apply positions (dual-key: matches n.id === nodeKey OR String(n.backendId) === nodeKey) ---
        let anyApplied = false;
        for (const [nodeKey, pos] of Object.entries(positions)) {
            const node = this.flowService.nodes().find((n) => n.id === nodeKey || String(n.backendId) === nodeKey);
            if (!node) {
                continue;
            }
            if (this.locallyDraggingNodeIds.has(node.id)) {
                continue;
            }
            this.flowService.applyRemotePosition(node.id, pos);
            anyApplied = true;
        }

        // --- Schema v2: structural reconciliation ---
        const isV2 = typeof schema_version === 'number' ? schema_version >= 2 : false;

        if (isV2) {
            // Apply tombstones first — drop nodes/connections that were deleted remotely.
            if (tombstones) {
                for (const tombstoneKey of Object.keys(tombstones)) {
                    if (tombstoneKey.startsWith('node:')) {
                        const nodeKey = tombstoneKey.slice('node:'.length);
                        const existing = this.flowService
                            .nodes()
                            .find((n) => n.id === nodeKey || String(n.backendId) === nodeKey);
                        if (existing) {
                            this.applyingRemote = true;
                            try {
                                this.flowService.applyRemoteDeleteNode(nodeKey, []);
                            } finally {
                                this.applyingRemote = false;
                            }
                            anyApplied = true;
                        }
                    } else if (tombstoneKey.startsWith('conn:')) {
                        const connId = tombstoneKey.slice('conn:'.length);
                        this.applyingRemote = true;
                        try {
                            this.flowService.applyRemoteRemoveConnection(connId);
                        } finally {
                            this.applyingRemote = false;
                        }
                        anyApplied = true;
                    }
                }
            }

            // Add nodes present in snapshot but missing locally.
            if (snapshotNodes) {
                for (const [nodeKey, nodePayload] of Object.entries(snapshotNodes)) {
                    const alreadyPresent = this.flowService
                        .nodes()
                        .find((n) => n.id === nodeKey || String(n.backendId) === nodeKey);
                    if (!alreadyPresent) {
                        this.applyingRemote = true;
                        try {
                            this.flowService.applyRemoteAddNode(nodeKey, nodePayload as NodeModel);
                        } finally {
                            this.applyingRemote = false;
                        }
                        anyApplied = true;
                    }
                }
            }

            // Add connections present in snapshot but missing locally (re-add previously dropped ones too).
            if (snapshotConnections) {
                for (const [connId, connEntry] of Object.entries(snapshotConnections)) {
                    const alreadyPresent = this.flowService.connections().some((c) => c.id === connId);
                    if (!alreadyPresent) {
                        const sourcePortId = connEntry.source_port_id as CustomPortId;
                        const targetPortId = connEntry.target_port_id as CustomPortId;
                        const sourceNodeId = sourcePortId.split('_')[0];
                        const targetNodeId = targetPortId.split('_')[0];
                        const storedConn = connEntry.connection;
                        const isStoredConnUsable =
                            typeof storedConn === 'object' &&
                            storedConn !== null &&
                            typeof (storedConn as Record<string, unknown>)['id'] === 'string';
                        const connectionModel: ConnectionModel = isStoredConnUsable
                            ? {
                                  ...(storedConn as ConnectionModel),
                                  id: connId,
                                  sourceNodeId,
                                  targetNodeId,
                                  sourcePortId,
                                  targetPortId,
                              }
                            : {
                                  id: connId,
                                  category: 'default',
                                  sourceNodeId,
                                  targetNodeId,
                                  sourcePortId,
                                  targetPortId,
                                  behavior: 'fixed',
                                  type: 'segment',
                                  data: null,
                              };
                        this.applyingRemote = true;
                        try {
                            this.flowService.applyRemoteAddConnection(connectionModel);
                        } finally {
                            this.applyingRemote = false;
                        }
                        anyApplied = true;
                    }
                }
            }
        }

        if (anyApplied) {
            this.cd.detectChanges();
            this.fFlowComponent?.redraw();
        }
    }

    /**
     * Applies a remote node-data update broadcast by another participant after they
     * saved or autosaved a node panel.
     *
     * Resolves backendNodeId → local node, regenerates ports from the incoming data,
     * then delegates to FlowService.applyRemoteNodeData (immutable signal update, no
     * undo, no decision-table sync).
     *
     * If the updated node's panel is open locally it means two users edited the same
     * node simultaneously — the lock system prevents this (only one holder at a time).
     * The comment is preserved here as a safety note.
     */
    public applyRemoteNodeDataUpdate(backendNodeId: number, nodeName: string, data: Record<string, unknown>): void {
        const node = this.flowService.nodes().find((n) => n.backendId === backendNodeId);
        if (!node) {
            return;
        }

        const newPorts = generatePortsForNode(node.id, node.type, data);
        this.flowService.applyRemoteNodeData(node.id, nodeName, data, newPorts);
        this.cd.detectChanges();
        this.fFlowComponent?.redraw();
    }

    /**
     * Applies a remote node-add broadcast from another participant.
     * Validates the payload minimally before touching canvas state — drops malformed
     * frames without throwing so a bad peer message cannot corrupt local state.
     * Resolves the node payload, calls the undo-bypassing FlowService method, then redraws.
     */
    public applyRemoteAddNode(msg: NodeAddedMessage): void {
        const payload = msg.node;
        if (
            typeof payload !== 'object' ||
            payload === null ||
            typeof (payload as Record<string, unknown>)['id'] !== 'string' ||
            ((payload as Record<string, unknown>)['id'] as string).length === 0 ||
            !(Object.values(NodeType) as unknown[]).includes((payload as Record<string, unknown>)['type'])
        ) {
            console.warn('[collab] applyRemoteAddNode: dropped malformed node payload', payload);
            return;
        }
        const nodeModel = payload as NodeModel;
        this.applyingRemote = true;
        try {
            this.flowService.applyRemoteAddNode(msg.node_key, nodeModel);
        } finally {
            this.applyingRemote = false;
        }
        this.cd.detectChanges();
        this.fFlowComponent?.redraw();
    }

    /**
     * Applies a remote node-delete broadcast from another participant.
     * Uses the server-supplied cascade connection list verbatim — does not recompute orphans.
     */
    public applyRemoteDeleteNode(msg: NodeDeletedMessage): void {
        this.applyingRemote = true;
        try {
            this.flowService.applyRemoteDeleteNode(msg.node_key, msg.removed_connection_ids);
        } finally {
            this.applyingRemote = false;
        }
        this.cd.detectChanges();
        this.fFlowComponent?.redraw();
    }

    /**
     * Applies a remote connection-add broadcast from another participant.
     * Drops the op if either endpoint node is not yet locally present (it will be
     * recovered by the next document_state resync).
     */
    public applyRemoteAddConnection(msg: ConnectionAddedMessage): void {
        const sourcePortId = msg.source_port_id as CustomPortId;
        const targetPortId = msg.target_port_id as CustomPortId;
        const sourceNodeId = sourcePortId.split('_')[0];
        const targetNodeId = targetPortId.split('_')[0];

        const connectionModel: ConnectionModel = {
            id: msg.connection_id,
            category: 'default',
            sourceNodeId,
            targetNodeId,
            sourcePortId,
            targetPortId,
            behavior: 'fixed',
            type: 'segment',
            data: null,
        };

        this.applyingRemote = true;
        try {
            this.flowService.applyRemoteAddConnection(connectionModel);
        } finally {
            this.applyingRemote = false;
        }
        this.cd.detectChanges();
        this.fFlowComponent?.redraw();
    }

    /**
     * Applies a remote connection-remove broadcast from another participant.
     * Missing connection is a no-op (idempotent).
     */
    public applyRemoteRemoveConnection(msg: ConnectionRemovedMessage): void {
        this.applyingRemote = true;
        try {
            this.flowService.applyRemoteRemoveConnection(msg.connection_id);
        } finally {
            this.applyingRemote = false;
        }
        this.cd.detectChanges();
        this.fFlowComponent?.redraw();
    }

    public onZoomInNode(node: NodeModel): void {
        this.fCanvasComponent.centerGroupOrNode(node.id, true);
    }

    public onNodeDoubleClickAndZoom(data: { node: NodeModel; event: MouseEvent }): void {
        const position = {
            x: data.node.position.x,
            y: data.node.position.y,
        };

        this.fCanvasComponent.centerGroupOrNode(data.node.id, false);
        this.fZoomDirective.setZoom(position, 1, EFZoomDirection.ZOOM_IN, true);
    }

    protected openSettings(): void {
        this.dialog.open(FlowSettingsPanelComponent, {
            width: '480px',
            maxWidth: '90vw',
        });
    }

    public onOpenCommandPalette(): void {
        if (this.isDialogOpen()) {
            return;
        }

        const dialogRef = this.dialog.open<PaletteResult>(CommandPaletteComponent, {
            panelClass: 'command-palette-panel',
            data: { canMutate: this.canEdit() } satisfies CommandPaletteData,
        });

        dialogRef.closed.subscribe((result: PaletteResult | undefined) => {
            this.hostRef.nativeElement.focus();

            if (!result) {
                return;
            }

            if (result.kind === 'create-node') {
                // Compute viewport-center screen point from the host element bounds.
                const rect = this.hostRef.nativeElement.getBoundingClientRect();
                const centerScreenPoint = PointExtensions.initialize(
                    rect.left + rect.width / 2,
                    rect.top + rect.height / 2
                );

                this.hasUnarrangedChanges.set(true);
                this.createNodeAt(result.request, centerScreenPoint);
            } else if (result.kind === 'goto-node') {
                const nodeExists = this.flowService.nodes().some((n) => n.id === result.nodeId);
                if (nodeExists) {
                    this.fCanvasComponent.centerGroupOrNode(result.nodeId, true);
                    this.cd.detectChanges();
                }
            } else {
                this.dispatchEditorAction(result.actionId);
            }
        });
    }

    private dispatchEditorAction(actionId: EditorActionId): void {
        if (MUTATING_EDITOR_ACTIONS.has(actionId) && !this.canEdit()) {
            return;
        }
        switch (actionId) {
            case EditorActionId.RunFlow:
                this.runRequested.emit();
                break;
            case EditorActionId.Save:
                this.emitSave();
                break;
            case EditorActionId.Undo:
                this.onUndo();
                break;
            case EditorActionId.Redo:
                this.onRedo();
                break;
            case EditorActionId.FitToScreen:
                this.fCanvasComponent.fitToScreen({ x: 200, y: 100 }, true);
                this.cd.detectChanges();
                break;
            case EditorActionId.OpenSettings:
                this.openSettings();
                break;
            case EditorActionId.OpenShortcuts:
                this.onOpenShortcuts(this.shortcutsAnchorRef?.nativeElement ?? this.hostRef.nativeElement);
                break;
            default: {
                const _exhaustive: never = actionId;
                console.warn('[FlowGraph] Unknown editor action:', _exhaustive);
            }
        }
    }

    public updateMouseTrackerPosition(event: IPoint): void {
        this.mouseCursorPosition = event;

        // Send throttled cursor position (~40 ms trailing throttle).
        const now = Date.now();
        if (now - this.lastCursorSentAt >= 40) {
            this.lastCursorSentAt = now;
            const flowPos = this.toFlowPosition(event);
            this.collaborationPresenceService.sendCursor({ x: flowPos.x, y: flowPos.y });
        }
    }

    /**
     * Handles foblex's `fSelectionChange` event on `<f-flow fDraggable>`.
     * Maps selected foblex node ids → backend ids and emits via collaboration.
     * Unsaved nodes (no backendId) are skipped.
     */
    public onSelectionChange(event: FSelectionChangeEvent): void {
        const nodes = this.flowService.nodes();
        const backendIds: number[] = [];
        for (const fNodeId of event.nodeIds) {
            const node = nodes.find((n) => n.id === fNodeId);
            if (node && typeof node.backendId === 'number') {
                backendIds.push(node.backendId);
            }
        }
        this.collaborationPresenceService.sendSelection({ node_ids: backendIds });
    }

    public onAutoArrange(): void {
        if (this._arrangingLock) return;
        this._arrangingLock = true;
        this.isArranging.set(true);
        if (this.arrangeBtnRef) {
            this.arrangeBtnRef.nativeElement.disabled = true;
        }

        const nodes = this.flowService.nodes();
        if (nodes.length === 0) {
            this._arrangingLock = false;
            this.isArranging.set(false);
            if (this.arrangeBtnRef) {
                this.arrangeBtnRef.nativeElement.disabled = false;
            }
            return;
        }

        const connections = this.flowService.connections();
        const newPositions = computeAutoArrangePositions(nodes, connections);

        const alreadyArranged = nodes.every((n) => {
            const target = newPositions.get(n.id);
            return !target || (n.position.x === target.x && n.position.y === target.y);
        });
        if (alreadyArranged) {
            this.hasUnarrangedChanges.set(false);
            this._arrangingLock = false;
            this.isArranging.set(false);
            return;
        }

        // Begin a batch for the entire auto-arrange gesture.
        this.undoRedoService.beginBatch();
        const startPositions = new Map(nodes.map((n) => [n.id, { ...n.position }]));

        // Pre-identify non-user-adjusted backward connections for per-frame arc updates.
        const backwardIds = this.backwardConnectionIds();
        const backwardConns = connections.filter(
            (c) => backwardIds.has(c.id) && !this.userAdjustedConnectionIds.has(c.id)
        );

        // Clear ALL non-user-adjusted waypoints (including backward) so every connection
        // starts from a clean state. Backward arcs are re-computed each frame below.
        for (const conn of connections) {
            if (conn.waypoints?.length && !this.userAdjustedConnectionIds.has(conn.id)) {
                this.flowService.updateConnectionWaypoints(conn.id, []);
            }
        }
        // Flush synchronously so nodes and arrows start from the same visual state.
        this.cd.detectChanges();
        this.fFlowComponent?.redraw();

        const DURATION = 400;
        const startTime = performance.now();

        const frame = (now: number): void => {
            const t = Math.min((now - startTime) / DURATION, 1);
            // ease-in-out quadratic
            const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

            const updatedNodes = nodes
                .filter((n) => newPositions.has(n.id))
                .map((n) => {
                    const from = startPositions.get(n.id) ?? n.position;
                    const to = newPositions.get(n.id)!;
                    return {
                        ...n,
                        position: {
                            x: Math.round(from.x + (to.x - from.x) * eased),
                            y: Math.round(from.y + (to.y - from.y) * eased),
                        },
                    };
                });

            // Update backward arc waypoints each frame using mid-animation node positions
            // (no node-avoidance so the arc stays compact and follows nodes smoothly).
            if (backwardConns.length > 0) {
                const nodeMap = new Map(updatedNodes.map((n) => [n.id, n]));
                for (const conn of backwardConns) {
                    const src = nodeMap.get(conn.sourceNodeId);
                    const tgt = nodeMap.get(conn.targetNodeId);
                    if (!src || !tgt) continue;
                    const srcPort = src.ports?.find((p) => p.id === conn.sourcePortId);
                    const tgtPort = tgt.ports?.find((p) => p.id === conn.targetPortId);
                    const srcPt = getPortPosition(src, srcPort);
                    const tgtPt = getPortPosition(tgt, tgtPort);
                    const arcPts = computeBackwardArcPoints(srcPt, tgtPt, undefined, []);
                    this.flowService.updateConnectionWaypoints(conn.id, [
                        { x: (arcPts[1].x + arcPts[4].x) / 2, y: arcPts[2].y },
                    ]);
                }
            }

            this.flowService.updateNodesInBatch(updatedNodes);
            this.cd.detectChanges();
            this.fFlowComponent?.redraw();

            if (t < 1) {
                this.arrangeAnimationId = requestAnimationFrame(frame);
            } else {
                this.arrangeAnimationId = null;
                // Restore proper segment routing after animation completes
                this.rerouteSegmentConnections();
                setTimeout(() => {
                    this.rerouteSegmentConnections();
                    // Recompute backward arcs without node-avoidance: after a full
                    // rearrange all nodes have moved so the avoidance logic pushes arcs
                    // far outside the visible area. A simple fixed-margin arc looks correct.
                    const finalNodes = this.flowService.nodes();
                    const finalConnections = this.flowService.connections();
                    const bwIds = this.backwardConnectionIds();
                    for (const conn of finalConnections) {
                        if (!bwIds.has(conn.id) || this.userAdjustedConnectionIds.has(conn.id)) continue;
                        const src = finalNodes.find((n) => n.id === conn.sourceNodeId);
                        const tgt = finalNodes.find((n) => n.id === conn.targetNodeId);
                        if (!src || !tgt) continue;
                        const srcPort = src.ports?.find((p) => p.id === conn.sourcePortId);
                        const tgtPort = tgt.ports?.find((p) => p.id === conn.targetPortId);
                        const srcPt = getPortPosition(src, srcPort);
                        const tgtPt = getPortPosition(tgt, tgtPort);
                        const arcPts = computeBackwardArcPoints(srcPt, tgtPt, undefined, []);
                        const waypoint = { x: (arcPts[1].x + arcPts[4].x) / 2, y: arcPts[2].y };
                        this.flowService.updateConnectionWaypoints(conn.id, [waypoint]);
                        this.bumpConnectionRenderVersion(conn.id);
                    }
                    this.cd.detectChanges();
                    this.fFlowComponent?.redraw();

                    // Record one move op per node that actually moved, then close the batch.
                    const arrangeEndNodes = this.flowService.nodes();
                    for (const node of arrangeEndNodes) {
                        const from = startPositions.get(node.id);
                        if (!from) continue;
                        if (from.x !== node.position.x || from.y !== node.position.y) {
                            this.undoRedoService.recordOp({
                                kind: 'move_node',
                                nodeId: node.id,
                                fromPosition: from,
                                toPosition: { x: node.position.x, y: node.position.y },
                            } satisfies OpMoveNode);
                        }
                    }
                    this.undoRedoService.endBatch();

                    this.hasUnarrangedChanges.set(false);
                    this._arrangingLock = false;
                    this.isArranging.set(false);
                    if (this.arrangeBtnRef) {
                        this.arrangeBtnRef.nativeElement.disabled = false;
                    }
                }, 0);
            }
        };

        this.arrangeAnimationId = requestAnimationFrame(frame);
    }

    public onDomainClick(): void {
        const startNodeInitialState = this.flowService.startNodeInitialState();

        const dialogRef = this.dialog.open(DomainDialogComponent, {
            width: '1000px',
            height: '800px',
            maxWidth: '90vw',
            maxHeight: '90vh',
            panelClass: 'domain-dialog-panel',
            backdropClass: 'domain-dialog-backdrop',
            data: {
                initialData: startNodeInitialState,
            },
        });

        dialogRef.closed.subscribe((result: unknown) => {
            if (result !== null && typeof result === 'object' && result !== undefined) {
                this.updateStartNodeInitialState(result as Record<string, unknown>);
            }
        });
    }

    public onProjectExpandToggled(project: ProjectNodeModel): void {
        const dialogRef = this.dialog.open(ProjectDialogComponent, {
            width: '90vw',
            height: '90vh',
            data: {
                projectId: project.data.id,
                projectName: project.data.name,
            },
        });

        dialogRef.closed.subscribe(() => {});
    }

    public onOpenShortcuts(anchorEl: HTMLElement): void {
        this.openShortcuts.emit(anchorEl.getBoundingClientRect());
    }

    private applyIncomingFlowState(flowState: FlowModel): void {
        const normalizedFlowState = normalizeFlowPorts(flowState);
        this.flowService.setFlow(normalizedFlowState);
        for (const conn of normalizedFlowState.connections) {
            if (conn.userAdjustedWaypoints) {
                this.userAdjustedConnectionIds.add(conn.id);
            } else {
                this.userAdjustedConnectionIds.delete(conn.id);
            }
        }
    }

    private isDialogOpen(): boolean {
        return this.dialog.openDialogs.length > 0;
    }

    /**
     * Shared node-creation path used by both the right-click context menu and
     * the command palette.
     *
     * Guards: canEdit check, End-uniqueness toast, and the `isDialogOpen` guard
     * (skipped here because the palette has already closed by the time this is
     * called from its `.closed` subscription).
     *
     * @param request  The creation request (type + optional overrides).
     * @param screenPoint  A screen-space point used to derive the canvas position
     *                     via `fFlowComponent.getPositionInFlow`. Pass the
     *                     context-menu mouse position or the viewport-center point.
     */
    private createNodeAt(request: CreateNodeRequest, screenPoint: IPoint): void {
        if (!this.canEdit()) {
            return;
        }

        if (request.type === NodeType.END && this.flowService.hasEndNode()) {
            this.toastService.warning('Only one End node is allowed', 4000, 'bottom-right');
            return;
        }

        const position = this.fFlowComponent.getPositionInFlow(
            PointExtensions.initialize(screenPoint.x, screenPoint.y)
        );
        const newNode = this.nodeFactory.createNode(request.type, { ...request.overrides, position });

        this.undoRedoService.recordOp({
            kind: 'add_node',
            node: newNode,
        } satisfies OpAddNode);
        this.flowService.addNode(newNode);

        if (!this.applyingRemote) {
            this.collaborationPresenceService.sendNodeAdd({
                node_key: this.nodeKey(newNode),
                node: newNode,
            });
        }
    }

    private updateStartNodeInitialState(newState: Record<string, unknown>): void {
        const startNode = this.flowService.nodes().find((node) => node.type === NodeType.START) as
            | StartNodeModel
            | undefined;

        if (startNode) {
            const updatedStartNode: StartNodeModel = {
                ...startNode,
                data: {
                    ...startNode.data,
                    initialState: newState,
                },
            };

            this.flowService.updateNode(updatedStartNode);
        } else {
            this.toastService.error('Start node not found');
        }
    }

    public openNodePanel(nodeId: string): void {
        const node = this.flowService.nodes().find((n) => n.id === nodeId);
        if (!node) {
            return;
        }
        // Route through trySelectNode so lock checks are applied even for deep-link opens.
        const selected = this.sidePanelService.trySelectNode(node);
        if (!selected && typeof node.backendId === 'number') {
            const holder = this.panelLockService.lockedByOther(node.backendId);
            if (holder !== null) {
                const participants = this.collaborationPresenceService.participants();
                const holderName = this.collabPresentation.resolveDisplayName(holder.userId, participants);
                this.toastService.error(`Node is being edited by ${holderName}`);
            }
            return;
        }
        afterNextRender(() => this.nodePanelShell?.expandPanel(), { injector: this.injector });
    }

    /**
     * Computes node_key per rule 1A:
     * - Saved node (backendId != null): String(backendId)
     * - Unsaved node (backendId == null): node.id (uuid)
     */
    private nodeKey(node: NodeModel): string {
        return node.backendId != null ? String(node.backendId) : node.id;
    }

    private toFlowPosition(point: IPoint): IPoint {
        return this.fFlowComponent.getPositionInFlow(PointExtensions.initialize(point.x, point.y));
    }

    private deleteSelections(selections: ICurrentSelection): void {
        if (!selections || (selections.fNodeIds.length === 0 && selections.fConnectionIds.length === 0)) {
            console.warn('No items selected to delete.');
            return;
        }

        const nodeIdsToDelete = selections.fNodeIds.filter((nodeId) => {
            const node = this.flowService.nodes().find((n) => n.id === nodeId);
            return node && node.type !== NodeType.START;
        });

        // Snapshot current state BEFORE deletion to compute outbound ops.
        const currentNodes = this.flowService.nodes();
        const currentConnections = this.flowService.connections();
        const nodeIdsToDeleteSet = new Set(nodeIdsToDelete);

        // Detect EDGE auto-deletes: connections being removed whose target is an EDGE node.
        const autoDeletedEdgeNodeIds = new Set<string>();
        for (const conn of currentConnections) {
            const connId = selections.fConnectionIds.includes(conn.id) ? conn.id : null;
            if (!connId) continue;
            const targetNode = currentNodes.find((n) => n.id === conn.targetNodeId);
            if (targetNode?.type === NodeType.EDGE) {
                autoDeletedEdgeNodeIds.add(targetNode.id);
                nodeIdsToDeleteSet.add(targetNode.id);
            }
        }

        // Connections to remove (explicitly selected + orphaned by node deletes).
        const connectionIdsToRemove = new Set<string>();
        for (const connId of selections.fConnectionIds) {
            connectionIdsToRemove.add(connId);
        }
        for (const conn of currentConnections) {
            if (nodeIdsToDeleteSet.has(conn.sourceNodeId) || nodeIdsToDeleteSet.has(conn.targetNodeId)) {
                connectionIdsToRemove.add(conn.id);
            }
        }

        if (!this.applyingRemote) {
            // Emit connection_removed for each connection being deleted.
            for (const connId of connectionIdsToRemove) {
                this.collaborationPresenceService.sendConnectionRemove({ connection_id: connId });
            }

            // Emit node_deleted for each node being deleted (explicit + EDGE auto-deletes).
            for (const nodeId of nodeIdsToDeleteSet) {
                const node = currentNodes.find((n) => n.id === nodeId);
                if (node) {
                    this.collaborationPresenceService.sendNodeDelete({ node_key: this.nodeKey(node) });
                }
            }
        }

        // Record undo ops BEFORE mutation (capture current objects).
        if (!this.undoRedoService.replaying) {
            this.undoRedoService.beginBatch();

            // Record connection-remove ops for explicitly selected connections
            // that are NOT covered by a node-delete (to avoid double-recording).
            for (const connId of selections.fConnectionIds) {
                const conn = currentConnections.find((c) => c.id === connId);
                if (conn) {
                    this.undoRedoService.recordOp({
                        kind: 'remove_connection',
                        connection: conn,
                    } satisfies OpRemoveConnection);
                }
            }

            // Record delete_node ops (each carries the orphaned connections so undo can re-add them).
            for (const nodeId of nodeIdsToDeleteSet) {
                const node = currentNodes.find((n) => n.id === nodeId);
                if (!node) continue;

                const orphanedConnections = currentConnections.filter(
                    (c) =>
                        (c.sourceNodeId === nodeId || c.targetNodeId === nodeId) &&
                        !selections.fConnectionIds.includes(c.id)
                );

                this.undoRedoService.recordOp({
                    kind: 'delete_node',
                    node,
                    removedConnections: orphanedConnections,
                } satisfies OpDeleteNode);
            }

            this.undoRedoService.endBatch();
        }

        this.flowService.deleteSelections({
            fNodeIds: nodeIdsToDelete,
            fConnectionIds: selections.fConnectionIds,
        });
    }

    /**
     * Executes a sequence of ops through the normal local mutation + broadcast path.
     * Used by onUndo() and onRedo().
     *
     * The `replaying` flag is set for the duration so recording sites skip creating
     * new undo entries. The WS self-echo guard (`applyingRemote` = false) ensures
     * the broadcast IS emitted — the echo will arrive with origin === selfMemberId
     * and be dropped at the normal guard, so no double-apply occurs.
     *
     * SYNC NOTE: replay is fully synchronous — this is a plain for-loop over
     * executeSingleOp, which calls only synchronous FlowService signal mutators and
     * CollaborationPresenceService.send* methods (no await, no Promise, no setTimeout,
     * no rAF). JS single-threadedness therefore guarantees that no inbound WebSocket
     * message handler can interleave mid-replay while `replaying` is true, so no
     * guard in applyRemoteNodeMove/applyRemoteAddNode/etc. is needed.
     */
    private replayOps(ops: readonly FlowOp[]): void {
        this.undoRedoService.replaying = true;
        try {
            for (const op of ops) {
                this.executeSingleOp(op);
            }
        } finally {
            this.undoRedoService.replaying = false;
        }

        this.rerouteSegmentConnections();
        this.cd.detectChanges();
        this.fFlowComponent?.redraw();
    }

    /**
     * Executes a single FlowOp locally and broadcasts to collaborators.
     * Called exclusively from replayOps().
     */
    private executeSingleOp(op: FlowOp): void {
        switch (op.kind) {
            case 'add_node': {
                this.flowService.addNode(op.node);
                this.collaborationPresenceService.sendNodeAdd({
                    node_key: this.nodeKey(op.node),
                    node: op.node,
                });
                break;
            }

            case 'delete_node': {
                const nodeKey = this.nodeKey(op.node);
                // Determine orphaned connections from the service's current state
                // (peers may have added connections to this node concurrently — additive LWW).
                const allConnectionsForNode = this.flowService
                    .connections()
                    .filter((c) => c.sourceNodeId === op.node.id || c.targetNodeId === op.node.id);

                for (const conn of allConnectionsForNode) {
                    this.collaborationPresenceService.sendConnectionRemove({ connection_id: conn.id });
                }
                this.collaborationPresenceService.sendNodeDelete({ node_key: nodeKey });

                this.flowService.deleteSelections({
                    fNodeIds: [op.node.id],
                    fConnectionIds: [],
                });
                break;
            }

            case 'move_node': {
                const node = this.flowService.nodes().find((n) => n.id === op.nodeId);
                if (!node) break;

                const updated = { ...node, position: op.toPosition };
                this.flowService.updateNode(updated);

                if (typeof updated.backendId === 'number') {
                    this.collaborationPresenceService.sendNodeMove({
                        node_id: updated.backendId,
                        x: op.toPosition.x,
                        y: op.toPosition.y,
                    });
                }
                break;
            }

            case 'update_node_data': {
                this.flowService.updateNode(op.updatedNode);

                if (typeof op.updatedNode.backendId === 'number') {
                    this.collaborationPresenceService.sendNodeDataUpdate({
                        node_id: op.updatedNode.backendId,
                        node_name: op.updatedNode.node_name,
                        data: op.updatedNode.data as Record<string, unknown>,
                    });
                }
                break;
            }

            case 'add_connection': {
                this.flowService.addConnection(op.connection);
                const sourceNode = this.flowService.nodes().find((n) => n.id === op.connection.sourceNodeId);
                const targetNode = this.flowService.nodes().find((n) => n.id === op.connection.targetNodeId);
                this.collaborationPresenceService.sendConnectionAdd({
                    connection_id: op.connection.id,
                    source_node_key: sourceNode ? this.nodeKey(sourceNode) : op.connection.sourceNodeId,
                    target_node_key: targetNode ? this.nodeKey(targetNode) : op.connection.targetNodeId,
                    source_port_id: op.connection.sourcePortId,
                    target_port_id: op.connection.targetPortId,
                    connection: op.connection,
                });
                break;
            }

            case 'remove_connection': {
                this.collaborationPresenceService.sendConnectionRemove({ connection_id: op.connection.id });
                this.flowService.removeConnection(op.connection.id);
                break;
            }
        }
    }

    private resolveTableOverlaps(node: NodeModel): string[] {
        if (node.type !== NodeType.TABLE) {
            return [];
        }

        const movedNodes = resolveOverlapsForNode(node.id, this.flowService.nodes());

        if (movedNodes.length > 0) {
            this.flowService.updateNodesInBatch(movedNodes);
        }

        return movedNodes.map((movedNode) => movedNode.id);
    }

    private snapToGrid(value: number): number {
        return Math.round(value / this.GRID_CELL_SIZE) * this.GRID_CELL_SIZE;
    }

    private findNearestFreePosition(
        position: IPoint,
        bounds: ReturnType<typeof getCollisionBounds>,
        nodes: NodeModel[]
    ): IPoint {
        return findNearestFreePosition(position, bounds, nodes);
    }

    private getCollisionBounds(node: NodeModel) {
        return getCollisionBounds(node);
    }

    private ensureNodeSize(node: NodeModel): NodeModel {
        return normalizeTableNodeSize(node);
    }

    private getDecisionTableVisualHeight(node: NodeModel): number {
        return normalizeTableNodeSize(node).size.height;
    }

    private normalizeWaypointsForConnection(connection: ConnectionModel, waypoints: IPoint[] | undefined): IPoint[] {
        return normalizeConnectionWaypoints(connection, this.flowService.nodes(), waypoints);
    }

    private bumpConnectionRenderVersion(connectionId: string): void {
        this.connectionRenderVersions.update((v) => ({
            ...v,
            [connectionId]: (v[connectionId] ?? 0) + 1,
        }));
    }

    private syncAfterAutoAlign(affectedNodeIds: Set<string>): void {
        const affectedConnectionIds = this.flowService
            .connections()
            .filter(
                (connection) =>
                    affectedNodeIds.has(connection.sourceNodeId) || affectedNodeIds.has(connection.targetNodeId)
            )
            .map((connection) => connection.id);

        if (affectedConnectionIds.length === 0) {
            this.rerouteSegmentConnections();
            this.cd.detectChanges();
            this.fFlowComponent?.redraw();
            return;
        }

        this.hiddenConnectionIds.set(new Set(affectedConnectionIds));
        this.cd.detectChanges();
        this.fFlowComponent?.redraw();

        requestAnimationFrame(() => {
            this.rerouteSegmentConnections();

            for (const connectionId of affectedConnectionIds) {
                this.bumpConnectionRenderVersion(connectionId);
            }

            this.hiddenConnectionIds.set(new Set<string>());
            this.cd.detectChanges();

            requestAnimationFrame(() => {
                this.fFlowComponent?.redraw();
            });
        });
    }
}
