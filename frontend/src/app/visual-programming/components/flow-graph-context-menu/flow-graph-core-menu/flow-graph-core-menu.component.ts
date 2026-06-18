import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { FlowGraphBlock, NODE_BLOCKS } from '../../../core/constants/node-blocks';
import { NodeType } from '../../../core/enums/node-type';
import { CreateNodeRequest } from '../../../core/models/node-creation.types';
import { FlowService } from '../../../services/flow.service';

export type { FlowGraphBlock };

@Component({
    selector: 'app-flow-graph-core-menu',
    standalone: true,
    template: `
        <ul>
            @for (block of filteredBlocks(); track block.type) {
                <li
                    (click)="onBlockClicked(block.type)"
                    [style.border-left-color]="block.color"
                    [class.disabled]="isDisabled(block.type)"
                >
                    <i
                        [class]="block.icon"
                        [style.color]="block.color"
                    ></i>
                    {{ block.label }}
                    <i class="ti ti-plus plus-icon"></i>
                </li>
            }
        </ul>
    `,
    styles: [
        `
            ul {
                list-style: none;
                padding: 0 16px;
                margin: 0;
            }

            li {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 16px;
                border-radius: 8px;
                gap: 14px;
                cursor: pointer;
                transition: background 0.2s ease;
                position: relative;
            }

            .node-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
            }

            .node-label {
                color: #fff;
            }

            li:hover {
                background: #2a2a2a;
            }

            .plus-icon {
                margin-left: auto;
                color: #bbb;
                opacity: 0;
                transition:
                    opacity 0.2s ease,
                    color 0.2s ease;
            }

            li:hover .plus-icon {
                opacity: 1;
                color: inherit;
            }

            li.disabled {
                opacity: 0.5;
                cursor: not-allowed;
                pointer-events: none;
            }
        `,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlowGraphCoreMenuComponent {
    private readonly flowService = inject(FlowService);

    public readonly searchTerm = input('');
    public readonly nodeSelected = output<CreateNodeRequest>();

    public readonly filteredBlocks = computed(() =>
        NODE_BLOCKS.filter((block) => block.label.toLowerCase().includes(this.searchTerm().toLowerCase()))
    );

    public onBlockClicked(type: NodeType): void {
        if (this.isDisabled(type)) {
            return;
        }
        this.nodeSelected.emit({ type });
    }

    public isDisabled(type: NodeType): boolean {
        if (type === NodeType.END) {
            return this.flowService.hasEndNode();
        }

        return false;
    }
}
