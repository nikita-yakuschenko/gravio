import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { Project } from '@/types/space';

function buildScene(project: Project): THREE.Scene {
  const scene = new THREE.Scene();

  project.floors.forEach((floor) => {
    floor.spaces.forEach((space) => {
      const geometry = new THREE.BoxGeometry(space.width, 300, space.height);
      const material = new THREE.MeshStandardMaterial({ color: space.color });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = space.name;
      mesh.position.set(
        space.x + space.width / 2,
        floor.elevation + 150,
        space.y + space.height / 2,
      );
      scene.add(mesh);
    });
  });

  return scene;
}

function triggerDownload(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportToGltf(project: Project): void {
  const scene = buildScene(project);
  const exporter = new GLTFExporter();

  exporter.parse(
    scene,
    (result) => {
      triggerDownload(result as ArrayBuffer, 'model.glb');
    },
    (error) => {
      console.error('GLTFExporter error:', error);
    },
    { binary: true },
  );
}
