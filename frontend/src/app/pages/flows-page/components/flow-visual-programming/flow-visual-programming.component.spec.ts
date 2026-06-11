import { Dialog as CdkDialog } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { EMPTY, of, Subject, throwError } from 'rxjs';

import { ImportExportService } from '../../../../core/services/import-export.service';
import { EpicChatService } from '../../../../features/epic-chat/epic-chat.service';
import { CreateGraphWarningsService } from '../../../../features/flows/services/create-graph-warnings.service';
import { FlowsApiService } from '../../../../features/flows/services/flows-api.service';
import { FlowsStorageService } from '../../../../features/flows/services/flows-storage.service';
import { RunGraphService } from '../../../../features/flows/services/run-graph-session.service';
import { RunSessionSSEService } from '../../../../pages/running-graph/services/graph-session-sse.service';
import { ProfileService } from '../../../../services/auth/profile.service';
import { FlushRequestedMessage } from '../../../../services/collaboration/collab-message.model';
import { CollaborationPresenceService } from '../../../../services/collaboration/collaboration-presence.service';
import { ConfigService } from '../../../../services/config/config.service';
import { ToastService } from '../../../../services/notifications/toast.service';
import { UnsavedChangesDialogService } from '../../../../shared/components/unsaved-changes-dialog/unsaved-changes-dialog.service';
import { FlowService } from '../../../../visual-programming/services/flow.service';
import { SidePanelService } from '../../../../visual-programming/services/side-panel.service';
import { UndoRedoService } from '../../../../visual-programming/services/undo-redo.service';
import { FlowUnsavedStateService } from '../../services/flow-unsaved-state.service';
import { FlowVisualProgrammingComponent } from './flow-visual-programming.component';

// ---------------------------------------------------------------------------
// Minimal stubs — only the members the component actually touches.
// ---------------------------------------------------------------------------

class RouterStub {
    navigate = jasmine.createSpy('navigate').and.returnValue(Promise.resolve(true));
}

class ActivatedRouteStub {
    paramMap = of({ get: () => '1' });
    queryParamMap = of({ get: () => null });
    snapshot = {
        paramMap: { get: () => '1' },
        queryParamMap: { get: () => null },
    };
}

class FlowsStorageServiceStub {}

class FlowServiceStub {
    getFlowState = jasmine.createSpy().and.returnValue({ nodes: [], connections: [] });
    setFlow = jasmine.createSpy();
    updateNode = jasmine.createSpy();
    nodes = signal<unknown[]>([]);
    startNodeInitialState = signal<unknown>(null);
}

class FlowsApiServiceStub {
    getGraphById = jasmine.createSpy().and.returnValue(EMPTY);
    getGraphsLight = jasmine.createSpy().and.returnValue(of([]));
    bulkSaveGraph = jasmine.createSpy().and.returnValue(EMPTY);
    patchGraph = jasmine.createSpy().and.returnValue(EMPTY);
    saveGraphVersion = jasmine.createSpy().and.returnValue(EMPTY);
}

class ToastServiceStub {
    success = jasmine.createSpy();
    error = jasmine.createSpy();
    warning = jasmine.createSpy();
}

class RunGraphServiceStub {
    runGraph = jasmine.createSpy().and.returnValue(EMPTY);
}

const flushRequestedSubject = new Subject<FlushRequestedMessage>();

class CollaborationPresenceServiceStub {
    participantCount = signal(0);
    participants = signal<unknown[]>([]);
    connectionState = signal('disconnected');
    selfMemberId = signal<string | null>(null);
    isDesignated = signal(false);
    flushRequested$ = flushRequestedSubject.asObservable();
    remoteNodeMove$ = EMPTY;
    documentState$ = EMPTY;
    remoteCursor$ = EMPTY;
    remoteSelection$ = EMPTY;
    lockGranted$ = EMPTY;
    lockDenied$ = EMPTY;
    nodeLocked$ = EMPTY;
    nodeUnlocked$ = EMPTY;
    lockState$ = EMPTY;
    remoteNodeDataUpdate$ = EMPTY;
    remoteNodeAdded$ = EMPTY;
    remoteNodeDeleted$ = EMPTY;
    remoteConnectionAdded$ = EMPTY;
    remoteConnectionRemoved$ = EMPTY;
    connect = jasmine.createSpy();
    disconnect = jasmine.createSpy();
}

class ProfileServiceStub {
    currentUserSignal = signal<unknown>(null);
}

class ConfigServiceStub {
    isEpicChatEnabled = false;
    apiUrl = 'http://localhost:8000/api/';
    realtimeApiUrl = 'http://localhost:8001';
}

class EpicChatServiceStub {
    requestCreateAgent = jasmine.createSpy();
}

class FlowUnsavedStateServiceStub {
    register = jasmine.createSpy();
    unregister = jasmine.createSpy();
}

class UnsavedChangesDialogServiceStub {
    confirmUnsavedChanges = jasmine.createSpy().and.returnValue(of('dont-save'));
    confirm = jasmine.createSpy().and.returnValue(EMPTY);
}

class UndoRedoServiceStub {
    setUndoStack = jasmine.createSpy();
    setRedoStack = jasmine.createSpy();
}

class CreateGraphWarningsServiceStub {
    readPending = jasmine.createSpy().and.returnValue([]);
}

class SidePanelServiceStub {
    saveNodeRequest$ = EMPTY;
    savingNodeId = signal<string | null>(null);
    markNodeSaving = jasmine.createSpy();
    clearNodeSaving = jasmine.createSpy();
    notifyGraphSaved = jasmine.createSpy();
}

class RunSessionSSEServiceStub {
    startStream = jasmine.createSpy();
    stopStream = jasmine.createSpy();
}

class ImportExportServiceStub {
    exportFlow = jasmine.createSpy().and.returnValue(of(new Blob(['{}'], { type: 'application/json' })));
}

class CdkDialogStub {
    open = jasmine.createSpy('open').and.returnValue({ closed: EMPTY });
}

class OverlayStub {
    position = jasmine.createSpy('position').and.returnValue({
        global: () => ({ right: () => ({ top: () => ({}) }) }),
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FlowVisualProgrammingComponent', () => {
    let component: FlowVisualProgrammingComponent;
    let collabService: CollaborationPresenceServiceStub;
    let importExportService: ImportExportServiceStub;
    let toastService: ToastServiceStub;

    beforeEach(() => {
        TestBed.configureTestingModule({
            imports: [HttpClientTestingModule, FlowVisualProgrammingComponent],
            providers: [
                { provide: Router, useClass: RouterStub },
                { provide: ActivatedRoute, useClass: ActivatedRouteStub },
                { provide: FlowsStorageService, useClass: FlowsStorageServiceStub },
                { provide: FlowService, useClass: FlowServiceStub },
                { provide: FlowsApiService, useClass: FlowsApiServiceStub },
                { provide: ToastService, useClass: ToastServiceStub },
                { provide: RunGraphService, useClass: RunGraphServiceStub },
                { provide: CollaborationPresenceService, useClass: CollaborationPresenceServiceStub },
                { provide: ProfileService, useClass: ProfileServiceStub },
                { provide: ConfigService, useClass: ConfigServiceStub },
                { provide: EpicChatService, useClass: EpicChatServiceStub },
                { provide: FlowUnsavedStateService, useClass: FlowUnsavedStateServiceStub },
                { provide: UnsavedChangesDialogService, useClass: UnsavedChangesDialogServiceStub },
                { provide: UndoRedoService, useClass: UndoRedoServiceStub },
                { provide: CreateGraphWarningsService, useClass: CreateGraphWarningsServiceStub },
                { provide: SidePanelService, useClass: SidePanelServiceStub },
                { provide: RunSessionSSEService, useClass: RunSessionSSEServiceStub },
                { provide: ImportExportService, useClass: ImportExportServiceStub },
                { provide: CdkDialog, useClass: CdkDialogStub },
                { provide: Overlay, useClass: OverlayStub },
            ],
            schemas: [NO_ERRORS_SCHEMA],
        });

        component = TestBed.createComponent(FlowVisualProgrammingComponent).componentInstance;
        collabService = TestBed.inject(CollaborationPresenceService) as unknown as CollaborationPresenceServiceStub;
        importExportService = TestBed.inject(ImportExportService) as unknown as ImportExportServiceStub;
        toastService = TestBed.inject(ToastService) as unknown as ToastServiceStub;
    });

    // -------------------------------------------------------------------------
    // flush_requested: only designated client reacts
    // -------------------------------------------------------------------------

    describe('flush_requested handling', () => {
        it('does NOT save when the client is not designated', () => {
            // Set graphState so the flow_id guard in the subscription passes.
            (component as unknown as { graphState: ReturnType<typeof signal> }).graphState.set({ id: 1 });
            collabService.isDesignated.set(false);
            const saveCurrentStateSpy = spyOn(component, 'saveCurrentState').and.returnValue(of(undefined));

            flushRequestedSubject.next({ type: 'flush_requested', flow_id: 1, reason: 'periodic' });

            expect(saveCurrentStateSpy).not.toHaveBeenCalled();
        });

        it('calls saveCurrentState when the client IS designated', () => {
            // Set graphState so the flow_id guard in the subscription passes.
            (component as unknown as { graphState: ReturnType<typeof signal> }).graphState.set({ id: 1 });
            collabService.isDesignated.set(true);
            const saveCurrentStateSpy = spyOn(component, 'saveCurrentState').and.returnValue(of(undefined));

            flushRequestedSubject.next({ type: 'flush_requested', flow_id: 1, reason: 'periodic' });

            expect(saveCurrentStateSpy).toHaveBeenCalledTimes(1);
        });
    });

    // -------------------------------------------------------------------------
    // ngOnDestroy leave-flush
    // -------------------------------------------------------------------------

    describe('ngOnDestroy leave-flush', () => {
        it('calls saveCurrentState before disconnect when there are unsaved changes', () => {
            spyOn(component, 'hasUnsavedChanges').and.returnValue(true);
            const saveCurrentStateSpy = spyOn(component, 'saveCurrentState').and.returnValue(of(undefined));

            component.ngOnDestroy();

            expect(saveCurrentStateSpy).toHaveBeenCalledTimes(1);
            // disconnect is called regardless — leave-flush happens before it
            expect(collabService.disconnect).toHaveBeenCalled();
        });

        it('does NOT call saveCurrentState on destroy when there are no unsaved changes', () => {
            spyOn(component, 'hasUnsavedChanges').and.returnValue(false);
            const saveCurrentStateSpy = spyOn(component, 'saveCurrentState').and.returnValue(of(undefined));

            component.ngOnDestroy();

            expect(saveCurrentStateSpy).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // savedLabel computed signal
    // -------------------------------------------------------------------------

    describe('savedLabel computed signal', () => {
        it('returns empty string when no save has happened and isSaving is false', () => {
            component.isSaving.set(false);
            expect(component.savedLabel()).toBe('');
        });

        it('returns "Syncing…" while isSaving is true', () => {
            component.isSaving.set(true);
            expect(component.savedLabel()).toBe('Syncing…');
        });

        it('returns "Saved · just now" immediately after a successful save', () => {
            // Trigger the lastSavedAt by accessing the private signal via casting.
            (component as unknown as { lastSavedAt: ReturnType<typeof signal> }).lastSavedAt.set(Date.now());
            component.isSaving.set(false);

            expect(component.savedLabel()).toBe('Saved · just now');
        });

        it('returns a minute-based label after 60 or more seconds', () => {
            const sixtyOneSecondsAgo = Date.now() - 61_000;
            (component as unknown as { lastSavedAt: ReturnType<typeof signal> }).lastSavedAt.set(sixtyOneSecondsAgo);
            component.isSaving.set(false);

            expect(component.savedLabel()).toBe('Saved · 1m ago');
        });

        it('re-evaluates the label when nowTick advances (interval-driven update)', () => {
            // Simulate a save that happened just now so the label starts as "just now".
            (component as unknown as { lastSavedAt: ReturnType<typeof signal> }).lastSavedAt.set(Date.now());
            component.isSaving.set(false);
            expect(component.savedLabel()).toBe('Saved · just now');

            // Advancing nowTick forces savedLabel to re-compute on the next read.
            // Simultaneously back-date lastSavedAt to simulate 61 s elapsed.
            const sixtyOneSecondsAgo = Date.now() - 61_000;
            (component as unknown as { lastSavedAt: ReturnType<typeof signal> }).lastSavedAt.set(sixtyOneSecondsAgo);
            (component as unknown as { nowTick: ReturnType<typeof signal> }).nowTick.update(
                (v: unknown) => (v as number) + 1
            );

            expect(component.savedLabel()).toBe('Saved · 1m ago');
        });
    });

    // -------------------------------------------------------------------------
    // handleExportFlow — pre-flush before download
    // -------------------------------------------------------------------------

    describe('handleExportFlow', () => {
        it('calls saveCurrentState before exportFlow', () => {
            // Set a minimal graph so the method does not bail out early.
            (component as unknown as { graphState: ReturnType<typeof signal> }).graphState.set({
                id: 7,
                name: 'my-flow',
            });

            const saveOrder: string[] = [];
            spyOn(component, 'saveCurrentState').and.callFake(() => {
                saveOrder.push('save');
                return of(undefined);
            });
            importExportService.exportFlow.and.callFake(() => {
                saveOrder.push('export');
                return of(new Blob(['{}'], { type: 'application/json' }));
            });

            // Stub downloadBlob to avoid DOM side-effects in tests.
            spyOn(document, 'createElement').and.callThrough();

            component.handleExportFlow();

            expect(saveOrder).toEqual(['save', 'export']);
        });

        it('shows a success toast after export', () => {
            (component as unknown as { graphState: ReturnType<typeof signal> }).graphState.set({
                id: 7,
                name: 'my-flow',
            });
            spyOn(component, 'saveCurrentState').and.returnValue(of(undefined));
            importExportService.exportFlow.and.returnValue(of(new Blob(['{}'], { type: 'application/json' })));

            component.handleExportFlow();

            expect(toastService.success).toHaveBeenCalledWith(jasmine.stringContaining('exported successfully'));
        });

        it('shows an error toast when export fails', () => {
            (component as unknown as { graphState: ReturnType<typeof signal> }).graphState.set({
                id: 7,
                name: 'my-flow',
            });
            spyOn(component, 'saveCurrentState').and.returnValue(of(undefined));
            // Return an observable that errors
            importExportService.exportFlow.and.returnValue(throwError(() => new Error('network error')));

            component.handleExportFlow();

            expect(toastService.error).toHaveBeenCalledWith(jasmine.stringContaining('Failed to export'));
        });
    });
});
