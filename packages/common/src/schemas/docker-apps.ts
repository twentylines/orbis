export type DockerApp = {
  id: string;
  name: string;
  source: 'docker' | 'runtipi';
  containers: { id: string; name: string; image: string; state: string; service: string | null }[];
  running: number;
  removable: boolean;
  unavailableReason: string | null;
};

export type DockerApps = { apps: DockerApp[]; sampledAt: string; protectedContainers: number };
export type DockerAppRemoval = {
  app: DockerApp;
  reviewId: string;
  storage: { type: 'bind' | 'volume'; name: string; destination: string }[];
  retainsData: true;
};
