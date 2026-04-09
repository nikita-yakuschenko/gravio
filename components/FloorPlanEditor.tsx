'use client';

import dynamic from 'next/dynamic';
import { useProjectStore } from '@/store/projectStore';

const FloorPlanCanvas = dynamic(() => import('./FloorPlanCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center w-full h-full text-gray-400 text-sm">
      Loading canvas…
    </div>
  ),
});

export default function FloorPlanEditor() {
  const { activeFloorId, selectedSpaceId, setSelectedSpace } = useProjectStore();

  if (!activeFloorId) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        No active floor. Add a floor to start.
      </div>
    );
  }

  return (
    <div className="flex" style={{ height: '100%' }}>
      <div className="flex-1 relative" style={{ overflow: 'hidden' }}>
        <FloorPlanCanvas
          floorId={activeFloorId}
          selectedId={selectedSpaceId}
          onSelect={setSelectedSpace}
        />
      </div>
    </div>
  );
}
