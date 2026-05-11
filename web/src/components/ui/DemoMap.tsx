import { ReactFlow, Background, BackgroundVariant, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const CLASS_COLORS: Record<string, string> = {
  C2: '#2e85c4', C3: '#2a9b7a', C5: '#c45a2a', HS: '#4caf50', NS: '#7b3fc4',
};

function DemoNode({ data }: { data: Record<string, unknown> }) {
  const color = CLASS_COLORS[data.cls as string] ?? '#4a6080';
  const isHome = data.home as boolean;
  return (
    <div style={{
      background:   '#0d1421',
      border:       `1.5px solid ${color}`,
      borderRadius: 6,
      padding:      '6px 12px',
      minWidth:     110,
      boxShadow:    isHome ? `0 0 10px ${color}66` : 'none',
      fontFamily:   'inherit',
    }}>
      <div style={{ fontSize: 10, color, fontWeight: 700, marginBottom: 2 }}>
        {data.cls as string}{isHome ? ' ★' : ''}
      </div>
      <div style={{ fontSize: 12, color: '#c8d8f0', fontWeight: 600 }}>{data.label as string}</div>
      {data.effect && (
        <div style={{ fontSize: 9, color: '#5a7090', marginTop: 2 }}>{data.effect as string}</div>
      )}
    </div>
  );
}

const nodeTypes = { demo: DemoNode };

const NODES: Node[] = [
  { id: 'home',  type: 'demo', position: { x: 300, y: 160 }, data: { label: 'J174618', cls: 'C3', effect: 'Pulsar', home: true } },
  { id: 'c2a',   type: 'demo', position: { x: 80,  y: 60  }, data: { label: 'J112233', cls: 'C2', home: false } },
  { id: 'c5a',   type: 'demo', position: { x: 530, y: 60  }, data: { label: 'J998877', cls: 'C5', home: false } },
  { id: 'hsa',   type: 'demo', position: { x: 80,  y: 280 }, data: { label: 'Amarr',   cls: 'HS', home: false } },
  { id: 'nsa',   type: 'demo', position: { x: 530, y: 280 }, data: { label: 'J556677', cls: 'NS', home: false } },
  { id: 'c2b',   type: 'demo', position: { x: 300, y: 330 }, data: { label: 'J445566', cls: 'C2', home: false } },
];

const EDGES: Edge[] = [
  { id: 'e1', source: 'home', target: 'c2a', style: { stroke: '#2e85c4', strokeWidth: 2 } },
  { id: 'e2', source: 'home', target: 'c5a', style: { stroke: '#c45a2a', strokeWidth: 2, strokeDasharray: '6 3' } },
  { id: 'e3', source: 'home', target: 'hsa', style: { stroke: '#4caf50', strokeWidth: 2 } },
  { id: 'e4', source: 'home', target: 'nsa', style: { stroke: '#7b3fc4', strokeWidth: 2 } },
  { id: 'e5', source: 'home', target: 'c2b', style: { stroke: '#2e85c4', strokeWidth: 2 } },
];

export function DemoMap() {
  return (
    <div style={{ width: '100%', height: 420, borderRadius: 8, overflow: 'hidden', border: '1px solid #1a2535', background: '#08090f' }}>
      <ReactFlow
        nodes={NODES}
        edges={EDGES}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1a2535" variant={BackgroundVariant.Dots} gap={24} size={1} />
      </ReactFlow>
      <div style={{
        position:   'absolute',
        bottom:     12,
        right:      12,
        display:    'flex',
        alignItems: 'center',
        gap:        8,
        background: '#0d1421cc',
        border:     '1px solid #1a2535',
        borderRadius: 6,
        padding:    '6px 10px',
        pointerEvents: 'none',
      }}>
        <img
          src="https://images.evetech.net/characters/1841929906/portrait?size=32"
          alt="Character"
          style={{ width: 24, height: 24, borderRadius: '50%', border: '1px solid #2e4a7a' }}
        />
        <span style={{ fontSize: 11, color: '#8a9ab8' }}>Live demo chain</span>
      </div>
    </div>
  );
}
