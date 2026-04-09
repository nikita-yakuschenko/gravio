import { Project } from '@/types/space';

export function exportToJson(project: Project): void {
  const json = JSON.stringify(project, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'project.json';
  a.click();
  URL.revokeObjectURL(url);
}
