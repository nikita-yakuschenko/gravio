'use client';

import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Group, Rect, Text, Line } from 'react-konva';
import Konva from 'konva';
import { useProjectStore } from '@/store/projectStore';

const PALETTE = [
  '#EF9A9A', '#F48FB1', '#CE93D8', '#90CAF9',
  '#80DEEA', '#A5D6A7', '#FFE082', '#FFCC80', '#BCAAA4',
];
const GRID = 40;

interface Props {
  floorId: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

function buildGrid(width: number, height: number) {
  const lines: number[][] = [];
  for (let x = 0; x <= width; x += GRID) lines.push([x, 0, x, height]);
  for (let y = 0; y <= height; y += GRID) lines.push([0, y, width, y]);
  return lines;
}

export default function FloorPlanCanvas({ floorId, selectedId, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const { project, addSpace, updateSpace } = useProjectStore();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > 0 && h > 0) setSize({ width: w, height: h });
    };

    const ro = new ResizeObserver(measure);
    ro.observe(el);

    // Delay initial read until after browser layout
    const raf = requestAnimationFrame(measure);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  const floor = project.floors.find((f) => f.id === floorId);
  const isEmpty = !floor?.spaces.length;

  const handleStageClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (!(e.target instanceof Konva.Stage)) return;
    const pos = e.target.getPointerPosition();
    if (!pos) return;
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    addSpace(floorId, {
      x: pos.x - 100,
      y: pos.y - 75,
      width: 200,
      height: 150,
      color,
      name: 'Room',
    });
    onSelect(null);
  };

  const gridLines = buildGrid(size.width, size.height);
  const ready = size.width > 0 && size.height > 0;

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, background: '#fff' }}>
      {ready && <Stage
        width={size.width}
        height={size.height}
        onClick={handleStageClick}
      >
        {/* Grid layer */}
        <Layer listening={false}>
          {gridLines.map((pts, i) => (
            <Line key={i} points={pts} stroke="#E5E7EB" strokeWidth={1} />
          ))}
        </Layer>

        {/* Spaces layer */}
        <Layer>
          {floor?.spaces.map((space) => (
            <Group
              key={space.id}
              x={space.x}
              y={space.y}
              draggable
              onClick={(e) => {
                e.cancelBubble = true;
                onSelect(space.id);
              }}
              onDragEnd={(e) => {
                updateSpace(floorId, space.id, {
                  x: e.target.x(),
                  y: e.target.y(),
                });
              }}
            >
              <Rect
                width={space.width}
                height={space.height}
                fill={space.color}
                opacity={0.85}
                stroke={selectedId === space.id ? '#1565C0' : '#9CA3AF'}
                strokeWidth={selectedId === space.id ? 2 : 1}
                dash={selectedId === space.id ? [8, 4] : []}
                cornerRadius={4}
              />
              <Text
                x={8}
                y={8}
                text={space.name}
                fontSize={13}
                fill="#1F2937"
                listening={false}
              />
            </Group>
          ))}
        </Layer>
      </Stage>}

      {/* Empty-state hint — shown as HTML overlay, not Konva */}
      {isEmpty && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-400 select-none">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M12 8v8M8 12h8" />
          </svg>
          <p className="text-sm">Кликните в любом месте, чтобы добавить комнату</p>
        </div>
      )}
    </div>
  );
}
