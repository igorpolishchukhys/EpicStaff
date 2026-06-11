import { NgIf, NgStyle, NgTemplateOutlet } from '@angular/common';
import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    computed,
    EventEmitter,
    Input,
    input,
    Output,
    signal,
} from '@angular/core';
import { EFResizeHandleType, FFlowModule } from '@foblex/flow';

import { AppSvgIconComponent } from '../../../shared/components/app-svg-icon/app-svg-icon.component';
import { GoToButtonComponent } from '../../../shared/components/go-to-button/go-to-button.component';
import { flowUrl } from '../../../shared/utils/flow-links';
import { ClickOrDragDirective } from '../../core/directives/click-or-drag.directive';
import { getNodeTitle } from '../../core/enums/node-title.util';
import { NodeType } from '../../core/enums/node-type';
import {
    AgentNodeModel,
    DecisionTableNodeModel,
    EdgeNodeModel,
    EndNodeModel,
    GraphNoteModel,
    LLMNodeModel,
    NodeModel,
    ProjectNodeModel,
    PythonNodeModel,
    ScheduleTriggerNodeModel,
    StartNodeModel,
    SubGraphNodeModel,
    TaskNodeModel,
    ToolNodeModel,
} from '../../core/models/node.model';
import { CustomPortId } from '../../core/models/port.model';
import { FlowService } from '../../services/flow.service';
import { ConditionalEdgeNodeComponent } from '../nodes-components/conditional-edge/conditional-edge.component';
import { DecisionTableNodeComponent } from '../nodes-components/decision-table-node/decision-table-node.component';
import { GraphNoteComponent } from '../nodes-components/graph-note/graph-note.component';
import { FlowNodeVariablesOverlayComponent } from './flow-node-variables-overlay.component';

@Component({
    selector: 'app-flow-base-node',
    templateUrl: './flow-base-node.component.html',
    styleUrls: ['./flow-base-node.component.scss'],
    standalone: true,
    imports: [
        FFlowModule,
        NgIf,
        NgStyle,
        NgTemplateOutlet,
        ClickOrDragDirective,
        ConditionalEdgeNodeComponent,
        DecisionTableNodeComponent,
        GraphNoteComponent,
        FlowNodeVariablesOverlayComponent,
        GoToButtonComponent,
        AppSvgIconComponent,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        '[class]': 'getNodeClass()',
        '[style.--remote-selection-color]': 'remoteSelection()?.color ?? null',
        '[style.--remote-lock-color]': 'remoteLock()?.color ?? null',
    },
})
export class FlowBaseNodeComponent {
    // 1. Inputs / Outputs
    @Input({ required: true }) node!: NodeModel;
    @Input() showVariables: boolean = false;

    /**
     * When true, the current user is a viewer (no 'flows:update' permission).
     * The delete button is hidden and edit/delete clicks are suppressed so the
     * node emits no edit or delete events. Drag is blocked at the canvas level.
     */
    readonly viewerMode = input<boolean>(false);

    /**
     * When a remote collaborator has selected this node, pass `{color, displayName}`
     * here. A coloured outline and a small name badge will be shown. Pass `null`
     * (the default) to show no remote-selection indicator.
     */
    readonly remoteSelection = input<{ color: string; displayName: string } | null>(null);

    /**
     * When a remote collaborator currently holds the panel lock on this node, pass
     * `{color, displayName}` here. A dashed lock-outline and a lock badge will be
     * shown. Pass `null` (the default) to show no lock indicator.
     */
    readonly remoteLock = input<{ color: string; displayName: string } | null>(null);

    @Output() fNodeSizeChange = new EventEmitter<{
        width: number;
        height: number;
    }>();
    @Output() editClicked = new EventEmitter<NodeModel>();
    @Output() deleteClicked = new EventEmitter<NodeModel>();
    @Output() projectExpandToggled = new EventEmitter<ProjectNodeModel>();
    @Output() portMouseenter = new EventEmitter<void>();
    @Output() portMouseleave = new EventEmitter<void>();

    // 3. Signals & Computed
    public isExpanded = signal(false);
    public isToggleDisabled = signal(false);

    public NodeType = NodeType;
    public readonly eResizeHandleType = EFResizeHandleType;

    public portConnections = computed((): Record<string, CustomPortId[]> => {
        if (!this.node) {
            return {};
        }

        if (!this.node.ports) {
            return {};
        }

        const fullMap = this.flowService.portConnectionsMap();
        return this.node.ports.reduce(
            (acc, port) => {
                acc[port.id] = fullMap[port.id] || [];
                return acc;
            },
            {} as Record<string, CustomPortId[]>
        );
    });

    constructor(
        public flowService: FlowService,
        private cdr: ChangeDetectorRef
    ) {}

    public onDeleteClick(event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        if (this.viewerMode()) {
            return;
        }
        this.deleteClicked.emit(this.node);
    }

    public onEditClick(event?: MouseEvent): void {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        if (this.viewerMode()) {
            return;
        }
        if (this.isBlockedSubgraph) {
            return;
        }
        this.editClicked.emit(this.node);
    }

    trackByPort(index: number, port: { id: string }): string {
        return port.id;
    }

    public getNodeClass(): string {
        const blockedClass = this.isBlockedSubgraph ? ' is-blocked' : '';
        switch (this.node.type) {
            case NodeType.AGENT:
                return 'type-agent';
            case NodeType.TASK:
                return 'type-task';
            case NodeType.PROJECT:
                return 'type-project';
            case NodeType.TOOL:
                return 'type-tool';
            case NodeType.LLM:
                return 'type-llm';
            case NodeType.PYTHON:
                return 'type-python';
            case NodeType.EDGE:
                return 'type-edge';
            case NodeType.START:
                return 'type-start';
            case NodeType.TABLE:
                return 'type-table';
            case NodeType.NOTE:
                return 'type-note';
            default:
                return `type-default${blockedClass}`;
        }
    }

    // Getters for specific node types
    public get agentNode() {
        return this.node.type === NodeType.AGENT ? (this.node as AgentNodeModel) : null;
    }

    public get taskNode() {
        return this.node.type === NodeType.TASK ? (this.node as TaskNodeModel) : null;
    }

    public get toolNode() {
        return this.node.type === NodeType.TOOL ? (this.node as ToolNodeModel) : null;
    }

    public get llmNode() {
        return this.node.type === NodeType.LLM ? (this.node as LLMNodeModel) : null;
    }

    public get pythonNode() {
        return this.node.type === NodeType.PYTHON ? (this.node as PythonNodeModel) : null;
    }

    public get edgeNode() {
        return this.node.type === NodeType.EDGE ? (this.node as EdgeNodeModel) : null;
    }

    public get tableNode() {
        return this.node.type === NodeType.TABLE ? (this.node as DecisionTableNodeModel) : null;
    }

    public get startNode() {
        return this.node.type === NodeType.START ? (this.node as StartNodeModel) : null;
    }
    public get endNode() {
        return this.node.type === NodeType.END ? (this.node as EndNodeModel) : null;
    }
    public get noteNode() {
        return this.node.type === NodeType.NOTE ? (this.node as GraphNoteModel) : null;
    }
    public get isBlockedSubgraph(): boolean {
        return this.node?.type === NodeType.SUBGRAPH && !!this.node.isBlocked;
    }
    public onExpandProjectClick(): void {
        this.projectExpandToggled.emit(this.node as ProjectNodeModel);
    }

    public getNodeTitle(): string {
        return getNodeTitle(this.node);
    }

    onNodeSizeChanged(size: { width: number; height: number }): void {
        this.fNodeSizeChange.emit(size);
    }

    get isScheduleTriggerActive(): boolean {
        return (
            this.node.type === NodeType.SCHEDULE_TRIGGER &&
            (this.node as ScheduleTriggerNodeModel).data?.isActive === true
        );
    }

    public getSelectedFlowUrl(): string | null {
        if (this.node?.type !== NodeType.SUBGRAPH) return null;
        if (this.isBlockedSubgraph) return null;
        const flowId = Number((this.node as SubGraphNodeModel).data?.id);
        if (!Number.isFinite(flowId) || flowId <= 0) return null;
        return flowUrl(flowId);
    }
}
