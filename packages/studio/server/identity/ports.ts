import type { FastifyRequest } from 'fastify';
import type { User, Project } from '../../shared/domain.ts';
export type Awaitable<T> = T | Promise<T>;
export interface IdentityStore {
  one(sql: string, ...args: any[]): Awaitable<any>;
  all(sql: string, ...args: any[]): Awaitable<any[]>;
  exec(sql: string, ...args: any[]): Awaitable<unknown>;
  projects(userId: string): Awaitable<Project[]>;
  publicUser(userId: string): Awaitable<User>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
  lock(key: string): Awaitable<void>;
  readonly db?: { readonly dialect: 'sqlite' | 'postgres' };
}
export interface IdentityAuth {
  user(request: FastifyRequest): Awaitable<User>;
  assertOrigin(request: FastifyRequest): Awaitable<void>;
}
export type RepositoryIdentitySettings = {
  clientId: string;
  clientSecret: string;
  encryptionKey: string;
  kind?: 'github-app' | 'oauth-app';
  authorizationUrl?: string;
  tokenUrl?: string;
  apiBaseUrl?: string;
  allowLoopback?: boolean;
  webhookSecret?: string;
  leaseSeconds?: number;
};
export type IdentitySettings = {
  origin: string;
  production: boolean;
  repositoryIdentity?: RepositoryIdentitySettings;
};
