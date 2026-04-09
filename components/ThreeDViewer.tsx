'use client';

import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useProjectStore } from '@/store/projectStore';
import { Floor, Space } from '@/types/space';

interface SpaceBoxProps {
  space: Space;
  elevation: number;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

function SpaceBox({ space, elevation, isSelected, onSelect }: SpaceBoxProps) {
  const px = space.x + space.width / 2;
  const py = elevation + 150;
  const pz = space.y + space.height / 2;

  return (
    <group
      position={[px, py, pz]}
      onClick={(e) => { e.stopPropagation(); onSelect(space.id); }}
    >
      {/* Solid box */}
      <mesh castShadow>
        <boxGeometry args={[space.width, 300, space.height]} />
        <meshStandardMaterial
          color={space.color}
          transparent
          opacity={0.9}
          emissive={space.color}
          emissiveIntensity={isSelected ? 0.35 : 0}
        />
      </mesh>

      {/* Selection wireframe */}
      {isSelected && (
        <mesh>
          <boxGeometry args={[space.width + 8, 308, space.height + 8]} />
          <meshBasicMaterial color="#3B82F6" wireframe />
        </mesh>
      )}
    </group>
  );
}

function FloorMeshes({
  floor,
  selectedSpaceId,
  onSelect,
}: {
  floor: Floor;
  selectedSpaceId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {floor.spaces.map((space: Space) => (
        <SpaceBox
          key={space.id}
          space={space}
          elevation={floor.elevation}
          isSelected={selectedSpaceId === space.id}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export default function ThreeDViewer() {
  const { project, selectedSpaceId, setSelectedSpace } = useProjectStore();

  return (
    <div style={{ width: '100%', height: '100%', background: '#111827' }}>
      <Canvas
        camera={{ position: [600, 700, 1000], fov: 50, near: 1, far: 30000 }}
        onPointerMissed={() => setSelectedSpace(null)}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[600, 1200, 600]} intensity={1.2} castShadow />
        <directionalLight position={[-400, 400, -400]} intensity={0.3} />

        <OrbitControls makeDefault target={[400, 150, 300]} />
        <gridHelper args={[4000, 100, '#374151', '#1F2937']} />

        {project.floors.map((floor) => (
          <FloorMeshes
            key={floor.id}
            floor={floor}
            selectedSpaceId={selectedSpaceId}
            onSelect={setSelectedSpace}
          />
        ))}
      </Canvas>
    </div>
  );
}
