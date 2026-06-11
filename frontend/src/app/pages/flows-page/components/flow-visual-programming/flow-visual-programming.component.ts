import { Dialog as CdkDialog } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import { HttpErrorResponse } from '@angular/common/http';
import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    HostListener,
    inject,
    OnDestroy,
    OnInit,
    signal,
    ViewChild,
} from '@angular/core';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import {
    catchError,
    defaultIfEmpty,
    EMPTY,
    filter,
    finalize,
    forkJoin,
    interval,
    map,
    Observable,
    of,
    switchMap,
    take,
    tap,
} from 'rxjs';

import { CanComponentDeactivate } from '../../../../core/guards/unsaved-changes.guard';
import { ImportExportService } from '../../../../core/services/import-export.service';
import { EpicChatService } from '../../../../features/epic-chat/epic-chat.service';
import { FlowSessionsListComponent } from '../../../../features/flows/components/flow-sessions-dialog/flow-sessions-list.component';
import { RestoreWarningsDialogComponent } from '../../../../features/flows/components/restore-warnings-dialog/restore-warnings-dialog.component';
import {
    SaveVersionDialogComponent,
    SaveVersionDialogResult,
} from '../../../../features/flows/components/save-version-dialog/save-version-dialog.component';
import { VersionHistoryPanelComponent } from '../../../../features/flows/components/version-history-panel/version-history-panel.component';
import {
    GetGraphLightRequest,
    GraphDto,
    GraphRestoreResponse,
    RestoreWarning,
} from '../../../../features/flows/models/graph.model';
import { CreateGraphWarningsService } from '../../../../features/flows/services/create-graph-warnings.service';
import { FlowsApiService } from '../../../../features/flows/services/flows-api.service';
import { FlowsStorageService } from '../../../../features/flows/services/flows-storage.service';
import { RunGraphService } from '../../../../features/flows/services/run-graph-session.service';
import { FlowMessagesPanelComponent } from '../../../../pages/running-graph/components/flow-messages-panel/flow-messages-panel.component';
import { RunSessionSSEService } from '../../../../pages/running-graph/services/graph-session-sse.service';
import { PermissionsService } from '../../../../services/auth/permissions.service';
import { ProfileService } from '../../../../services/auth/profile.service';
import {
    ConnectionAddedMessage,
    ConnectionRemovedMessage,
    DocumentStateMessage,
    FlushRequestedMessage,
    NodeAddedMessage,
    NodeDeletedMessage,
} from '../../../../services/collaboration/collab-message.model';
import { CollaborationPresenceService } from '../../../../services/collaboration/collaboration-presence.service';
import { ConfigService } from '../../../../services/config/config.service';
import { ToastService } from '../../../../services/notifications/toast.service';
import { AppSvgIconComponent } from '../../../../shared/components/app-svg-icon/app-svg-icon.component';
import { SpinnerComponent } from '../../../../shared/components/spinner/spinner.component';
import { UnsavedChangesDialogService } from '../../../../shared/components/unsaved-changes-dialog/unsaved-changes-dialog.service';
import { downloadBlob } from '../../../../shared/utils/download-blob.util';
import { NodeType } from '../../../../visual-programming/core/enums/node-type';
import { FlowModel } from '../../../../visual-programming/core/models/flow.model';
import { ScheduleTriggerNodeModel } from '../../../../visual-programming/core/models/node.model';
import { NodeModel } from '../../../../visual-programming/core/models/node.model';
import { FlowGraphComponent } from '../../../../visual-programming/flow-graph/flow-graph.component';
import { FlowService } from '../../../../visual-programming/services/flow.service';
import { SidePanelService } from '../../../../visual-programming/services/side-panel.service';
import { UndoRedoService } from '../../../../visual-programming/services/undo-redo.service';
import {
    createStartNode,
    hasStartNode,
    mapGraphDtoToFlowModel,
    normalizeFlowPorts,
} from '../../../../visual-programming/utils/load';
import { rewriteLegacyOnceScheduleName } from '../../../../visual-programming/utils/load/nodes/schedule-trigger-node.mapper';
import {
    buildBulkSavePayload,
    buildUuidToBackendIdMap,
    cloneFlowState,
    getConnectionDiff,
    getNodeDiff,
    patchFlowStateWithBackendIds,
} from '../../../../visual-programming/utils/save';
import { FlowUnsavedStateService } from '../../services/flow-unsaved-state.service';
import { FlowHeaderComponent } from './components/header/flow-header.component';
import { PresenceAvatarStackComponent } from './components/presence-avatar-stack/presence-avatar-stack.component';
import { ShortcutsModalComponent } from './components/shortcuts-modal/shortcuts-modal.component';
import { FLOW_SHORTCUT_SECTIONS } from './flow-shortcuts.config';

//.
@Component({
    selector: 'app-flow-visual-programming',
    standalone: true,
    imports: [
        AppSvgIconComponent,
        FlowHeaderComponent,
        FlowGraphComponent,
        PresenceAvatarStackComponent,
        SpinnerComponent,
        ShortcutsModalComponent,
        FlowMessagesPanelComponent,
    ],
    templateUrl: './flow-visual-programming.component.html',
    styleUrl: './flow-visual-programming.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlowVisualProgrammingComponent implements OnInit, OnDestroy, CanComponentDeactivate {
    private readonly destroyRef = inject(DestroyRef);

    public readonly isEpicChatEnabled: boolean;
    public initialNodeId: string | null = null;
    public isLoaded = signal(false);
    private readonly graphState = signal<GraphDto | null>(null);
    private readonly availableFlowLights = signal<GetGraphLightRequest[]>([]);
    private readonly savedFlowState = signal<FlowModel>({ nodes: [], connections: [] });
    public readonly loadedFlowState = computed<FlowModel>(() => {
        const graph = this.graphState();
        if (!graph) return { nodes: [], connections: [] };

        let flowModel = mapGraphDtoToFlowModel(graph);
        flowModel = this.addStartNodeIfNeeded(flowModel);
        const validated = this.validateSubgraphNodes(flowModel, this.availableFlowLights());
        return validated.flowModel;
    });
    public readonly currentFlowState = computed<FlowModel>(() => this.flowService.getFlowState());
    public readonly hasUnsavedChangesSignal = computed<boolean>(() => {
        return JSON.stringify(this.currentFlowState()) !== JSON.stringify(this.savedFlowState());
    });

    public isSaving = signal(false);
    public isRunning = signal(false);
    /** Timestamp (ms) of the most recent successful save. Null until the first save. */
    private readonly lastSavedAt = signal<number | null>(null);
    /**
     * Incremented every 30 s by a `setInterval` started in the constructor.
     * Reading it inside `savedLabel` makes the computed re-evaluate on each tick
     * so the relative-time portion stays current without requiring a signal write
     * to `lastSavedAt` or `isSaving`.
     */
    private readonly nowTick = signal<number>(0);
    /**
     * Human-readable save indicator exposed to the header.
     * - 'Syncing…'         while isSaving() is true
     * - 'Saved · just now' when last saved < 60 s ago
     * - 'Saved · Xm ago'   otherwise (based on minutes)
     * Note: get-relative-time.util.ts returns "0 m ago" sub-minute and has a
     * month-label bug, so the < 60 s and relative-minute cases are computed here.
     */
    public readonly savedLabel = computed<string>(() => {
        if (this.isSaving()) {
            return 'Syncing…';
        }
        const savedAt = this.lastSavedAt();
        if (savedAt === null) {
            return '';
        }
        // Reading nowTick() registers it as a reactive dependency so this computed
        // re-runs every 30 s even when lastSavedAt and isSaving have not changed.
        void this.nowTick();
        const elapsedMs = Date.now() - savedAt;
        if (elapsedMs < 60_000) {
            return 'Saved · just now';
        }
        const minutes = Math.floor(elapsedMs / 60_000);
        return `Saved · ${minutes}m ago`;
    });
    public restoreWarnings = signal<RestoreWarning[]>([]);
    /** Buffers the latest document_state message received before the flow finishes loading. */
    private readonly pendingDocumentState = signal<DocumentStateMessage | null>(null);

    public isPanelOpen = signal(false);
    public isPanelCollapsed = signal(true);
    public currentSessionId: string | null = null;
    public panelWidthPx = 450;
    public isDragging = false;
    private readonly MIN_PANEL_WIDTH = 430;
    private readonly MAX_PANEL_WIDTH_RATIO = 0.7;
    private readonly routeParamMap;
    private readonly routeQueryParamMap;
    private isDeactivating = false;

    @ViewChild(FlowGraphComponent)
    private flowGraphComponent?: FlowGraphComponent;

    public get graph(): GraphDto {
        return this.graphState()!;
    }

    public readonly presenceCount = computed(() => this.collaborationPresenceService.participantCount());
    public readonly presenceParticipants = computed(() => this.collaborationPresenceService.participants());
    public readonly currentUserId = computed<number | null>(() => this.profileService.currentUserSignal()?.id ?? null);
    /**
     * True only when BOTH conditions hold:
     *   1. The user has the org-level 'flows update' RBAC permission.
     *   2. The collab server has NOT marked this session as a viewer for this flow.
     *
     * Fail-closed: before the `self` frame arrives, `isViewer()` is false so RBAC
     * governs alone. Once the server marks the session a viewer, this gate locks
     * regardless of RBAC, preventing save/export from reaching a transport that
     * would reject the operation anyway.
     */
    public readonly canEdit = computed<boolean>(
        () => this.permissionsService.can('flows', 'update') && !this.collaborationPresenceService.isViewer()
    );

    private readonly collaborationPresenceService = inject(CollaborationPresenceService);
    private readonly permissionsService = inject(PermissionsService);
    private readonly profileService = inject(ProfileService);
    private readonly importExportService = inject(ImportExportService);

    constructor(
        private readonly route: ActivatedRoute,
        private readonly router: Router,
        private readonly flowStorageService: FlowsStorageService,
        private readonly flowService: FlowService,
        private readonly flowApiService: FlowsApiService,
        private readonly cdr: ChangeDetectorRef,
        private readonly toastService: ToastService,
        private readonly runGraphService: RunGraphService,
        private readonly dialog: CdkDialog,
        private readonly overlay: Overlay,
        private readonly configService: ConfigService,
        private readonly elementRef: ElementRef,
        private readonly epicChatService: EpicChatService,
        private readonly flowUnsavedStateService: FlowUnsavedStateService,
        private readonly unsavedChangesDialog: UnsavedChangesDialogService,
        private readonly undoRedoService: UndoRedoService,
        private readonly createGraphWarningService: CreateGraphWarningsService,
        private readonly runSessionSSEService: RunSessionSSEService,
        private readonly sidePanelService: SidePanelService
    ) {
        this.isEpicChatEnabled = this.configService.isEpicChatEnabled;
        this.routeParamMap = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
        this.routeQueryParamMap = toSignal(this.route.queryParamMap, {
            initialValue: this.route.snapshot.queryParamMap,
        });

        // Drive the relative-time portion of savedLabel by advancing nowTick every 30 s.
        // takeUntilDestroyed clears the subscription automatically when the component is destroyed.
        interval(30_000)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => this.nowTick.update((v) => v + 1));

        effect(() => {
            this.initialNodeId = this.routeQueryParamMap().get('nodeId');
        });

        effect(() => {
            const graphId = Number(this.routeParamMap().get('id'));
            if (!isFinite(graphId)) return;
            this.undoRedoService.setUndoStack([]);
            this.undoRedoService.setRedoStack([]);
            const warnings = this.createGraphWarningService.readPending();
            if (warnings.length) this.restoreWarnings.set(warnings);
            this.fetchGraph(graphId);
            this.collaborationPresenceService.connect(graphId);
        });

        this.sidePanelService.saveNodeRequest$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((node) => this.handleNodeSaveRequest(node));

        // Collaboration: apply remote node moves, guarded by flow_id.
        this.collaborationPresenceService.remoteNodeMove$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
            const currentId = this.graphState()?.id;
            if (msg.flow_id !== currentId) {
                return;
            }
            this.flowGraphComponent?.applyRemoteNodeMove(msg.node_id, { x: msg.x, y: msg.y });
        });

        // Collaboration: apply remote node data updates — filter self-echoes, guard flow_id.
        this.collaborationPresenceService.remoteNodeDataUpdate$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((msg) => {
                if (msg.origin === this.collaborationPresenceService.selfMemberId()) {
                    return;
                }
                const currentId = this.graphState()?.id;
                if (msg.flow_id !== currentId) {
                    return;
                }
                this.flowGraphComponent?.applyRemoteNodeDataUpdate(msg.node_id, msg.node_name, msg.data);
            });

        // Collaboration: buffer document_state until the flow canvas is loaded, then apply.
        this.collaborationPresenceService.documentState$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((msg) => {
            const currentId = this.graphState()?.id;
            if (msg.flow_id !== currentId) {
                return;
            }
            if (!this.isLoaded()) {
                // Buffer the latest document state — will be applied when load completes.
                this.pendingDocumentState.set(msg);
            } else {
                this.flowGraphComponent?.applyDocumentState(msg);
            }
        });

        // Flush buffered document_state once the flow finishes loading.
        effect(() => {
            if (!this.isLoaded()) {
                return;
            }
            const pending = this.pendingDocumentState();
            if (pending !== null) {
                this.pendingDocumentState.set(null);
                // Defer one tick so the ViewChild (FlowGraphComponent) has rendered.
                setTimeout(() => {
                    this.flowGraphComponent?.applyDocumentState(pending);
                }, 0);
            }
        });

        // Collaboration: apply remote node_added — filter self-echoes, guard flow_id.
        this.collaborationPresenceService.remoteNodeAdded$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((msg: NodeAddedMessage) => {
                if (msg.origin === this.collaborationPresenceService.selfMemberId()) {
                    return;
                }
                const currentId = this.graphState()?.id;
                if (msg.flow_id !== currentId) {
                    return;
                }
                this.flowGraphComponent?.applyRemoteAddNode(msg);
            });

        // Collaboration: apply remote node_deleted — filter self-echoes, guard flow_id.
        this.collaborationPresenceService.remoteNodeDeleted$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((msg: NodeDeletedMessage) => {
                if (msg.origin === this.collaborationPresenceService.selfMemberId()) {
                    return;
                }
                const currentId = this.graphState()?.id;
                if (msg.flow_id !== currentId) {
                    return;
                }
                this.flowGraphComponent?.applyRemoteDeleteNode(msg);
            });

        // Collaboration: apply remote connection_added — filter self-echoes, guard flow_id.
        this.collaborationPresenceService.remoteConnectionAdded$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((msg: ConnectionAddedMessage) => {
                if (msg.origin === this.collaborationPresenceService.selfMemberId()) {
                    return;
                }
                const currentId = this.graphState()?.id;
                if (msg.flow_id !== currentId) {
                    return;
                }
                this.flowGraphComponent?.applyRemoteAddConnection(msg);
            });

        // Collaboration: apply remote connection_removed — filter self-echoes, guard flow_id.
        this.collaborationPresenceService.remoteConnectionRemoved$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((msg: ConnectionRemovedMessage) => {
                if (msg.origin === this.collaborationPresenceService.selfMemberId()) {
                    return;
                }
                const currentId = this.graphState()?.id;
                if (msg.flow_id !== currentId) {
                    return;
                }
                this.flowGraphComponent?.applyRemoteRemoveConnection(msg);
            });

        // Collaboration: server-triggered flush — only the designated client acts on it.
        // Belt-and-braces: the server only sends flush_requested to the designated member,
        // but we re-check isDesignated() locally in case a race made both clients act.
        this.collaborationPresenceService.flushRequested$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((msg: FlushRequestedMessage) => {
                const currentId = this.graphState()?.id;
                if (msg.flow_id !== currentId) {
                    return;
                }
                if (!this.collaborationPresenceService.isDesignated()) {
                    return;
                }
                this.saveCurrentState().pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
            });
    }

    public ngOnInit(): void {
        this.flowUnsavedStateService.register(this);
    }

    public refreshCurrentFlow(): void {
        const graphId = Number(this.route.snapshot.paramMap.get('id'));
        if (!isFinite(graphId)) return;
        this.fetchGraph(graphId, true, true);
    }

    private fetchGraph(graphId: number, forceRefresh = false, showRefreshToast = false): void {
        forkJoin({
            graph: this.flowApiService.getGraphById(graphId, forceRefresh),
            flows: this.flowApiService.getGraphsLight().pipe(catchError(() => of([] as GetGraphLightRequest[]))),
        })
            .pipe(
                takeUntilDestroyed(this.destroyRef),
                tap(({ graph, flows }) => {
                    this.applyLoadedGraphState(graph, flows, showRefreshToast);
                }),
                catchError(() => {
                    this.toastService.error('Failed to load graph');
                    return EMPTY;
                }),
                finalize(() => this.cdr.markForCheck())
            )
            .subscribe();
    }

    public onHeaderSave(): void {
        this.flowGraphComponent?.emitSave();
    }

    public onGraphSave(flowState: FlowModel): void {
        if (!this.graph?.id || this.isSaving()) return;

        this.saveFlowState(flowState, true).pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
    }

    private saveFlowState(flowState: FlowModel, showSuccessToast: boolean): Observable<void> {
        if (!this.graph?.id) return EMPTY;
        if (!this.canEdit()) return EMPTY;

        const previous = this.loadedFlowState();
        const nodeDiff = getNodeDiff(previous, flowState);
        const idMap = buildUuidToBackendIdMap(flowState.nodes);
        const connectionDiff = getConnectionDiff(previous, flowState, idMap);
        const payload = buildBulkSavePayload(
            this.graph.id,
            nodeDiff,
            connectionDiff,
            flowState,
            idMap,
            this.graphState()!.save_version
        );

        this.isSaving.set(true);

        return this.flowApiService.bulkSaveGraph(this.graph.id, payload).pipe(
            switchMap((graph) =>
                this.flowApiService.getGraphsLight().pipe(
                    map((flows) => ({ graph, flows })),
                    catchError(() => of({ graph, flows: [] as GetGraphLightRequest[] }))
                )
            ),
            tap(({ graph, flows }) => {
                this.graphState.set(graph);
                this.availableFlowLights.set(flows);
                const patchedFlow = patchFlowStateWithBackendIds(flowState, previous, nodeDiff, graph);

                this.flowService.setFlow(patchedFlow);
                // Sync isActive from the save response: patchFlowStateWithBackendIds only assigns
                // backend IDs and does not propagate other backend-authoritative fields like is_active.
                for (const dto of graph.schedule_trigger_node_list ?? []) {
                    const node = patchedFlow.nodes.find(
                        (n): n is ScheduleTriggerNodeModel =>
                            n.type === NodeType.SCHEDULE_TRIGGER && (n as ScheduleTriggerNodeModel).backendId === dto.id
                    );
                    if (node && node.data.isActive !== dto.is_active) {
                        this.flowService.updateNode({ ...node, data: { ...node.data, isActive: dto.is_active } });
                    }
                }
                this.savedFlowState.set(cloneFlowState(patchedFlow));
                this.lastSavedAt.set(Date.now());
                this.sidePanelService.notifyGraphSaved();
                if (showSuccessToast) {
                    this.toastService.success('Graph saved successfully');
                }
            }),
            map(() => void 0),
            catchError((err: HttpErrorResponse) => {
                if (err.status === 409) {
                    this.toastService.warning(
                        'This graph was modified by another user. Please refresh to see the latest changes.'
                    );
                } else {
                    this.toastService.error(`Failed to save graph: ${err?.error?.error || 'Unknown error'}`);
                }
                return EMPTY;
            }),
            finalize(() => {
                this.isSaving.set(false);
                this.cdr.markForCheck();
            })
        );
    }

    private handleNodeSaveRequest(node: NodeModel): void {
        if (!this.graph?.id) return;
        if (this.sidePanelService.savingNodeId() === node.id) return;

        this.sidePanelService.markNodeSaving(node.id);
        this.saveNodeToBackend(node)
            .pipe(
                takeUntilDestroyed(this.destroyRef),
                finalize(() => this.sidePanelService.clearNodeSaving())
            )
            .subscribe();
    }

    private saveNodeToBackend(node: NodeModel): Observable<void> {
        if (!this.graph?.id) return EMPTY;

        this.flowService.updateNode(node);

        const previous = this.loadedFlowState();
        const previousForDiff: FlowModel = {
            nodes: node.backendId != null ? previous.nodes.filter((n) => n.backendId === node.backendId) : [],
            connections: [],
        };
        const singleNodeFlow: FlowModel = { nodes: [node], connections: [] };
        const nodeDiff = getNodeDiff(previousForDiff, singleNodeFlow);
        const connectionDiff = { toCreate: [], toUpdate: [], toDelete: [] };
        const idMap = buildUuidToBackendIdMap([node]);
        const payload = buildBulkSavePayload(
            this.graph.id,
            nodeDiff,
            connectionDiff,
            singleNodeFlow,
            idMap,
            this.graphState()!.save_version
        );

        return this.flowApiService.bulkSaveGraph(this.graph.id, payload).pipe(
            tap((responseGraph) => {
                this.graphState.set(responseGraph);
                const patchedFlow = patchFlowStateWithBackendIds(
                    this.currentFlowState(),
                    previous,
                    nodeDiff,
                    responseGraph
                );
                this.flowService.setFlow(patchedFlow);

                const savedNode = patchedFlow.nodes.find((n) => n.id === node.id);
                if (savedNode) {
                    const prev = this.savedFlowState();
                    const exists = prev.nodes.some((n) => n.id === node.id);
                    const nextNodes = exists
                        ? prev.nodes.map((n) => (n.id === node.id ? savedNode : n))
                        : [...prev.nodes, savedNode];
                    this.savedFlowState.set(cloneFlowState({ nodes: nextNodes, connections: prev.connections }));
                }

                this.toastService.success('Node saved');
            }),
            map(() => void 0),
            catchError((err: HttpErrorResponse) => {
                if (err.status === 409) {
                    this.toastService.warning(
                        'This graph was modified by another user. Please refresh to see the latest changes.'
                    );
                } else {
                    this.toastService.error(`Failed to save node: ${err?.error?.error || 'Unknown error'}`);
                }
                return EMPTY;
            })
        );
    }

    private saveGraphForRun(): Observable<void> {
        // Viewers cannot persist changes — skip the pre-run flush and run against the
        // last-saved graph state. The canvas may show local diffs, but the execution
        // will be based on whatever is persisted on the server.
        if (!this.canEdit()) return of(void 0);
        if (!this.hasUnsavedChanges()) return of(void 0);
        if (this.isSaving()) return EMPTY;

        return this.saveFlowState(this.currentFlowState(), false);
    }

    public saveCurrentState(): Observable<void> {
        if (!this.hasUnsavedChanges()) return of(void 0);
        return toObservable(this.isSaving).pipe(
            filter((saving) => !saving),
            take(1),
            switchMap(() => this.saveFlowState(this.currentFlowState(), false))
        );
    }

    public handleRunFlow(): void {
        if (this.isRunning() || !this.graph?.id) return;

        this.isRunning.set(true);

        const saveFirst$: Observable<void> = this.saveGraphForRun();

        saveFirst$
            .pipe(
                switchMap(() => this.runGraphService.runGraph(this.graph.id, this.graph.start_node_list[0].variables)),
                takeUntilDestroyed(this.destroyRef),
                tap((response: { session_id?: number }) => {
                    this.currentSessionId = response.session_id?.toString() ?? null;
                    if (this.currentSessionId) {
                        this.runSessionSSEService.startStream(this.currentSessionId);
                    }
                    this.isPanelOpen.set(true);
                    this.isPanelCollapsed.set(false);
                    this.cdr.markForCheck();
                }),
                catchError((error: { error?: { error?: string } }) => {
                    this.toastService.error(`Failed to run graph: ${error?.error?.error || 'Unknown error'}`);
                    return EMPTY;
                }),
                finalize(() => {
                    this.isRunning.set(false);
                    this.cdr.markForCheck();
                })
            )
            .subscribe();
    }

    public handleViewSessions(): void {
        if (!this.graph) return;
        this.dialog.open(FlowSessionsListComponent, {
            data: { flow: this.graph },
            panelClass: 'custom-dialog-panel',
        });
    }

    /**
     * In-editor export: flushes unsaved changes first so the exported file reflects
     * the current canvas state, then triggers the file download.
     * Viewers cannot export because the pre-export flush would persist changes they
     * are not permitted to make.
     */
    public handleExportFlow(): void {
        if (!this.graph?.id) return;
        if (!this.canEdit()) {
            this.toastService.warning('You have read-only access to this flow and cannot export it.');
            return;
        }

        const graphId = this.graph.id;
        const graphName = this.graph.name ?? `flow-${graphId}`;

        this.saveCurrentState()
            .pipe(
                switchMap(() => this.importExportService.exportFlow(graphId.toString())),
                takeUntilDestroyed(this.destroyRef)
            )
            .subscribe({
                next: (blob: Blob) => {
                    downloadBlob(blob, `${graphName}_export_${Date.now()}.json`);
                    this.toastService.success(`Flow "${graphName}" exported successfully`);
                },
                error: () => {
                    this.toastService.error(`Failed to export flow "${graphName}"`);
                },
            });
    }

    public handleGetCurl(): void {
        const flowUuid = this.graph?.uuid;
        const startNodeInitialState = this.flowService.startNodeInitialState();
        const apiUrl = this.configService.apiUrl;

        if (flowUuid && startNodeInitialState) {
            const curlCommand = this.generateCurlCommand(flowUuid, startNodeInitialState, apiUrl);
            this.copyToClipboard(curlCommand);
            this.toastService.success('CURL command copied to clipboard!');
        } else {
            this.toastService.error('Unable to generate CURL: Missing flow ID or start node data');
        }
    }

    private generateCurlCommand(flowUuid: string, variables: Record<string, unknown>, apiUrl: string): string {
        const payload = JSON.stringify(
            {
                graph_uuid: flowUuid,
                variables: variables,
            },
            null,
            2
        );

        return `curl \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json" \\
  -X POST \\
  -d '${payload}' \\
  ${apiUrl}run-session/`;
    }

    private async copyToClipboard(text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
        }
    }

    @HostListener('window:beforeunload', ['$event'])
    public handleBeforeUnload(event: BeforeUnloadEvent): string | void {
        if (this.hasUnsavedChanges()) {
            // Show the browser's native "Leave site?" dialog. The async save attempted in
            // ngOnDestroy is best-effort only: browsers aggressively cancel in-flight XHR/
            // fetch requests on page unload, so it may not complete. The reliable durability
            // paths are the periodic server-triggered flush (flush_requested) and the Angular
            // canDeactivate guard (which awaits the save before allowing navigation).
            event.preventDefault();
            return (event.returnValue = '');
        }
    }

    @HostListener('document:keydown', ['$event'])
    public handleCtrlS(event: KeyboardEvent): void {
        if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
            event.preventDefault();
            this.onHeaderSave();
        }
    }

    public hasUnsavedChanges(): boolean {
        return this.hasUnsavedChangesSignal();
    }

    public canDeactivate(): boolean | Observable<boolean> {
        if (this.isDeactivating) return true;
        if (!this.hasUnsavedChanges()) return true;

        this.isDeactivating = true;
        return this.unsavedChangesDialog
            .confirmUnsavedChanges(() =>
                this.saveFlowState(this.currentFlowState(), false).pipe(
                    map(() => true),
                    defaultIfEmpty(false),
                    catchError(() => of(false))
                )
            )
            .pipe(
                tap((result) => {
                    this.isDeactivating = false;
                    if (result === 'dont-save') {
                        this.savedFlowState.set(cloneFlowState(this.currentFlowState()));
                    }
                }),
                map((result) => result === 'save' || result === 'dont-save')
            );
    }

    public connectToEpicChat(): void {
        if (!this.graph?.id) {
            this.toastService.error('Unable to connect chat: Missing flow ID');
            return;
        }

        const flowUrl = this.normalizeApiUrl(this.configService.apiUrl);
        if (!flowUrl) {
            this.toastService.error('Unable to connect chat: Missing API URL');
            return;
        }

        this.flowApiService
            .patchGraph(this.graph.id, { epicchat_enabled: true, save_version: this.graphState()!.save_version })
            .subscribe({
                next: () => {
                    this.graph.epicchat_enabled = true;
                    this.epicChatService.requestCreateAgent({
                        name: this.graph.name?.trim() || `Flow ${this.graph.id}`,
                        description: this.graph.description?.trim(),
                        flowId: this.graph.id,
                        flowUrl,
                        selectAfterCreate: true,
                    });
                    this.toastService.success('Flow connected to Epic Chat');
                },
                error: () => {
                    this.toastService.error('Failed to save EpicChat connection');
                },
            });
    }

    private normalizeApiUrl(apiUrl: string): string {
        return (apiUrl || '').trim().replace(/\/+$/, '');
    }

    public closeMessagesPanel(): void {
        this.isPanelCollapsed.set(true);
        this.cdr.markForCheck();
        window.dispatchEvent(new Event('resize'));
    }

    public togglePanelCollapsed(): void {
        this.isPanelCollapsed.update((value) => !value);
        this.cdr.markForCheck();
        window.dispatchEvent(new Event('resize'));
    }

    public onSessionSelected(sessionId: string): void {
        this.currentSessionId = sessionId;
        this.cdr.markForCheck();
    }

    public onDragStart(event: MouseEvent): void {
        event.preventDefault();
        this.isDragging = true;
    }

    @HostListener('document:mousemove', ['$event'])
    public onDragMove(event: MouseEvent): void {
        if (!this.isDragging) return;
        const hostRect = this.elementRef.nativeElement.getBoundingClientRect();
        const maxWidth = hostRect.width * this.MAX_PANEL_WIDTH_RATIO;
        const newWidth = hostRect.right - event.clientX;
        this.panelWidthPx = Math.max(this.MIN_PANEL_WIDTH, Math.min(newWidth, maxWidth));
        this.cdr.markForCheck();
    }

    @HostListener('document:mouseup')
    public onDragEnd(): void {
        if (this.isDragging) {
            this.isDragging = false;
            window.dispatchEvent(new Event('resize'));
        }
    }

    public ngOnDestroy(): void {
        this.flowUnsavedStateService.unregister();
        this.runSessionSSEService.stopStream();
        // Leave-flush: if the user navigates away while there are unsaved changes, attempt
        // to persist them before the socket disconnects (empty-room durability).
        // takeUntilDestroyed has already completed by this lifecycle hook, so we subscribe
        // directly — the request completes independently of the component lifetime.
        if (this.hasUnsavedChanges()) {
            this.saveCurrentState().subscribe();
        }
        this.collaborationPresenceService.disconnect();
    }

    private addStartNodeIfNeeded(flowModel: FlowModel): FlowModel {
        if (hasStartNode(flowModel)) return flowModel;
        return { ...flowModel, nodes: [createStartNode(), ...flowModel.nodes] };
    }

    private validateSubgraphNodes(
        flowModel: FlowModel,
        flows: GetGraphLightRequest[]
    ): { flowModel: FlowModel; blockedCount: number } {
        const availableIds = new Set(flows.map((f) => f.id));
        let blockedCount = 0;

        const nextFlowModel: FlowModel = {
            ...flowModel,
            nodes: flowModel.nodes.map((node) => {
                if (node.type !== NodeType.SUBGRAPH) return node;
                const subgraphId = Number((node as { data?: { id?: unknown } })?.data?.id);
                const isMissing = !subgraphId || !availableIds.has(subgraphId);
                if (isMissing) blockedCount++;
                return { ...node, isBlocked: isMissing };
            }),
        };

        return { flowModel: nextFlowModel, blockedCount };
    }

    private applyLoadedGraphState(graph: GraphDto, flows: GetGraphLightRequest[], showRefreshToast: boolean): void {
        this.graphState.set(graph);
        this.availableFlowLights.set(flows);
        const normalizedFlow = normalizeFlowPorts(this.loadedFlowState());
        this.flowService.setFlow(normalizedFlow);
        // savedFlowState captures the as-persisted snapshot used for dirty-tracking.
        // It is set BEFORE the legacy-name rewrite so that flows with legacy names are
        // immediately marked dirty — the user accepted this behaviour (EST-2826).
        this.savedFlowState.set(cloneFlowState(normalizedFlow));

        // Eagerly rewrite legacy "at HH:MM" once-schedule names to "at HH-MM" in the
        // live canvas state. Because savedFlowState already holds the old names, the
        // flow will be marked dirty until the user saves, which is the intended UX.
        const rewrittenFlow: FlowModel = {
            ...normalizedFlow,
            nodes: normalizedFlow.nodes.map((node) => {
                if (node.type !== NodeType.SCHEDULE_TRIGGER) return node;
                const rewrittenName = rewriteLegacyOnceScheduleName(node.node_name);
                return rewrittenName !== node.node_name ? { ...node, node_name: rewrittenName } : node;
            }),
        };
        this.flowService.setFlow(rewrittenFlow);

        this.isLoaded.set(true);

        if (showRefreshToast) {
            this.toastService.success('Flow refreshed');
        }

        const blockedCount = this.countBlockedSubgraphNodes(this.loadedFlowState());
        if (blockedCount > 0) {
            this.toastService.warning(
                `${blockedCount} subgraph node(s) reference missing flows and were blocked.`,
                6000,
                'bottom-right'
            );
        }
    }

    private countBlockedSubgraphNodes(flowModel: FlowModel): number {
        return flowModel.nodes.filter((node) => node.type === NodeType.SUBGRAPH && node.isBlocked).length;
    }

    public isShortcutsOpen = signal(false);
    public shortcutsPos = signal<{ top: number; left: number } | null>(null);
    public readonly shortcutSections = FLOW_SHORTCUT_SECTIONS;

    public openShortcutsModal(rect: DOMRect): void {
        if (this.isShortcutsOpen()) {
            this.closeShortcutsModal();
            return;
        }

        const top = rect.top;
        const left = rect.right - 30;

        this.shortcutsPos.set({ top, left });
        this.isShortcutsOpen.set(true);
    }

    public closeShortcutsModal(): void {
        this.isShortcutsOpen.set(false);
        this.shortcutsPos.set(null);
    }

    public onFlowEdited(updatedFlow: GraphDto): void {
        this.graphState.set(updatedFlow);
        this.cdr.markForCheck();
    }

    public onViewVersionHistory(): void {
        if (!this.graph?.id) return;

        const positionStrategy = this.overlay.position().global().right('0').top('5rem');

        const dialogRef = this.dialog.open<GraphRestoreResponse | undefined>(VersionHistoryPanelComponent, {
            positionStrategy,
            height: 'calc(100% - 5rem)',
            width: '380px',
            data: {
                graphId: this.graph.id,
                graphSaveVersion: () => this.graphState()?.save_version,
                hasUnsavedChanges: () => this.hasUnsavedChanges(),
                saveCurrentState: () => this.saveCurrentState(),
            },
        });

        dialogRef.closed
            .pipe(
                takeUntilDestroyed(this.destroyRef),
                filter((result): result is GraphRestoreResponse => !!result?.restored)
            )
            .subscribe((response) => {
                this.restoreWarnings.set(response.warnings);
                this.undoRedoService.setUndoStack([]);
                this.undoRedoService.setRedoStack([]);
                this.refreshCurrentFlow();
            });
    }

    public onShowRestoreWarnings(): void {
        const dialogRef = this.dialog.open<number | undefined>(RestoreWarningsDialogComponent, {
            width: '560px',
            data: { warnings: this.restoreWarnings() },
        });

        dialogRef.closed
            .pipe(
                takeUntilDestroyed(this.destroyRef),
                filter((nodeId): nodeId is number => nodeId != null)
            )
            .subscribe((backendNodeId) => {
                const node = this.flowService.nodes().find((n) => n.backendId === backendNodeId);
                if (node) {
                    this.flowGraphComponent?.openNodePanel(node.id);
                }
            });
    }

    public onSaveVersion(): void {
        if (!this.graph.id) return;

        const openVersionDialog = () => {
            const dialogRef = this.dialog.open<SaveVersionDialogResult>(SaveVersionDialogComponent, {
                width: '560px',
                data: {},
            });

            dialogRef.closed
                .pipe(
                    takeUntilDestroyed(this.destroyRef),
                    filter((result): result is SaveVersionDialogResult => !!result),
                    switchMap((result) =>
                        this.flowApiService
                            .saveGraphVersion({
                                graph_id: this.graph.id,
                                name: result.name,
                                description: result.description,
                            })
                            .pipe(
                                tap(() => this.toastService.success(`Version '${result.name}' saved`)),
                                catchError(() => {
                                    this.toastService.error('Failed to save version');
                                    return EMPTY;
                                })
                            )
                    )
                )
                .subscribe();
        };

        if (!this.hasUnsavedChanges()) {
            openVersionDialog();
            return;
        }

        this.unsavedChangesDialog
            .confirm({
                title: 'Your flow has unsaved changes',
                message:
                    'Your flow has unsaved changes. <strong>Save</strong> the flow first to include them in the version, or <strong>continue</strong> to version the last saved state.',
                saveText: 'Save',
                dontSaveText: 'Continue',
                cancelText: 'Cancel',
                type: 'warning',
                showDontSave: true,
            })
            .pipe(
                takeUntilDestroyed(this.destroyRef),
                switchMap((result) => {
                    if (result === 'save') {
                        return this.saveFlowState(this.currentFlowState(), false).pipe(map(() => void 0));
                    }
                    if (result === 'dont-save') {
                        return of(void 0);
                    }
                    return EMPTY;
                })
            )
            .subscribe(() => openVersionDialog());
    }
}
