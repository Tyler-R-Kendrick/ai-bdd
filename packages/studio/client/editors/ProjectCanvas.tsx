import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus, ArrowUpRight } from 'lucide-react';
import { kindIcons } from '../App.tsx';
import { Button } from '../components/ui.tsx';
import {
  kindLabels,
  type Artifact,
  type Project,
} from '../../shared/domain.ts';
function ArtifactNode({ data }: NodeProps) {
  const a = data.artifact as Artifact,
    Icon = kindIcons[a.kind];
  return (
    <div
      className={
        'canvas-artifact ' + (a.kind === 'design' ? 'canvas-main' : '')
      }
    >
      <Handle type="target" position={Position.Left} />
      <div>
        <Icon size={18} />
        <span>{kindLabels[a.kind]}</span>
        <ArrowUpRight size={14} />
      </div>
      <strong>{a.title}</strong>
      <p>
        {a.kind === 'design'
          ? 'The intent, specification, and acceptance criteria.'
          : `${a.version} ${a.version === 1 ? 'revision' : 'revisions'} · dedicated discussion & ADR`}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { artifact: ArtifactNode };
export function ProjectCanvas({
  artifacts,
  project,
  onOpen,
  onCreate,
}: {
  artifacts: Artifact[];
  project: Project;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const main = artifacts.find((a) => a.id === project.mainArtifactId),
      children = artifacts.filter((a) => a !== main);
    return {
      nodes: [
        ...(main
          ? [
              {
                id: main.id,
                type: 'artifact',
                position: { x: 0, y: Math.max(0, (children.length - 1) * 100) },
                data: { artifact: main },
              },
            ]
          : []),
        ...children.map((a, i) => ({
          id: a.id,
          type: 'artifact',
          position: { x: 400 + Math.floor(i / 5) * 380, y: (i % 5) * 200 },
          data: { artifact: a },
        })),
      ],
      edges: children.map((a) => ({
        id: `${project.mainArtifactId}-${a.id}`,
        source: project.mainArtifactId,
        target: a.id,
        type: 'smoothstep',
        style: { stroke: '#b8bcb7', strokeWidth: 1.2 },
      })),
    };
  }, [artifacts, project.mainArtifactId]);
  return (
    <div className="project-canvas">
      <div className="canvas-heading">
        <div>
          <h1>{project.title}</h1>
          <p>{project.description || 'The whole project, connected.'}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onCreate}
          disabled={project.role === 'viewer'}
        >
          <Plus size={14} />
          Add artifact
        </Button>
      </div>
      <div className="flow-area">
        <ReactFlow
          key={artifacts.map((a) => a.id).join(',')}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.25}
          maxZoom={1.5}
          onNodeClick={(_, node) => onOpen(node.id)}
          nodesConnectable={false}
          aria-label="Project artifact composition"
        >
          <Background gap={24} size={1} color="#d9dcd6" />
          <Controls showInteractive={false} />
          {artifacts.length > 6 && (
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) =>
                n.id === project.mainArtifactId ? '#6b73d1' : '#d7d9d3'
              }
            />
          )}
        </ReactFlow>
      </div>
      <div className="canvas-caption">
        Select an artifact to open its canvas and conversation. Drag to arrange
        this view.
      </div>
    </div>
  );
}
