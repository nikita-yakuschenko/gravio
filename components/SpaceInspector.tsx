'use client';

import { useProjectStore } from '@/store/projectStore';
import { Space } from '@/types/space';

export default function SpaceInspector() {
  const { project, selectedSpaceId, setSelectedSpace, updateSpace, removeSpace } =
    useProjectStore();

  if (!selectedSpaceId) return null;

  // Search across all floors — 3D selection can target any floor
  let floorId: string | null = null;
  let space: Space | null = null;
  for (const floor of project.floors) {
    const found = floor.spaces.find((s) => s.id === selectedSpaceId);
    if (found) { floorId = floor.id; space = found; break; }
  }
  if (!floorId || !space) return null;

  const update = (changes: Partial<Space>) => updateSpace(floorId!, selectedSpaceId, changes);

  const inputStyle: React.CSSProperties = {
    border: '1px solid #D1D5DB', borderRadius: 6,
    padding: '5px 8px', fontSize: 13, width: '100%',
    outline: 'none', boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 4,
    fontSize: 13, fontWeight: 500, color: '#374151',
  };

  return (
    <div style={{
      width: 260, flexShrink: 0,
      borderLeft: '1px solid #E5E7EB',
      background: '#fff',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid #E5E7EB',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Properties
        </span>
        <button
          onClick={() => setSelectedSpace(null)}
          style={{ color: '#9CA3AF', background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 0 }}
        >
          ×
        </button>
      </div>

      {/* Fields */}
      <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 14, flex: 1, overflowY: 'auto' }}>
        <label style={labelStyle}>
          Name
          <input style={inputStyle} value={space.name} onChange={(e) => update({ name: e.target.value })} />
        </label>

        <label style={labelStyle}>
          Width (px)
          <input type="number" min={10} style={inputStyle}
            value={space.width}
            onChange={(e) => update({ width: Math.max(10, Number(e.target.value)) })} />
        </label>

        <label style={labelStyle}>
          Depth (px)
          <input type="number" min={10} style={inputStyle}
            value={space.height}
            onChange={(e) => update({ height: Math.max(10, Number(e.target.value)) })} />
        </label>

        <label style={labelStyle}>
          Color
          <input type="color" style={{ ...inputStyle, height: 38, padding: 2, cursor: 'pointer' }}
            value={space.color}
            onChange={(e) => update({ color: e.target.value })} />
        </label>
      </div>

      {/* Delete */}
      <div style={{ padding: '12px 14px', borderTop: '1px solid #E5E7EB', flexShrink: 0 }}>
        <button
          onClick={() => removeSpace(floorId!, selectedSpaceId)}
          style={{
            width: '100%', padding: '7px',
            background: '#FEF2F2', color: '#DC2626',
            border: '1px solid #FCA5A5', borderRadius: 6,
            cursor: 'pointer', fontSize: 13, fontWeight: 500,
          }}
        >
          Delete Room
        </button>
      </div>
    </div>
  );
}
