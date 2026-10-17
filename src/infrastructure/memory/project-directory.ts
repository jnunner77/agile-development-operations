import type { ProjectDirectory } from '#application/ports.ts';

export class MemoryProjectDirectory implements ProjectDirectory {
  readonly members: Set<string>;
  readonly sprints: Set<string>;
  readonly areaPath: string;

  constructor(options: { members?: readonly string[]; sprints?: readonly string[]; areaPath?: string } = {}) {
    this.members = new Set(options.members ?? []);
    this.sprints = new Set(options.sprints ?? []);
    this.areaPath = options.areaPath ?? 'Fabrikam';
  }

  async memberExists(id: string): Promise<boolean> {
    return this.members.has(id);
  }

  async sprintExists(id: string): Promise<boolean> {
    return this.sprints.has(id);
  }

  async defaultAreaPath(): Promise<string> {
    return this.areaPath;
  }
}
