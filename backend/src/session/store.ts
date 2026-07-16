import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

export type NodeType = 'terminal' | 'xpra';

export interface SessionNode {
  nodeId: string;
  parentId: string | null;   // null = direct child of username
  username: string;
  type: NodeType;
  name: string;              // display name (user-renameable)
  createdAt: number;         // Unix ms
  xpraPort?: number;         // assigned Xpra port for GUI windows
}

const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
});

// ── Key helpers ───────────────────────────────────────────────────────────────
const nodeKey = (nodeId: string) => `node:${nodeId}`;
const userNodesKey = (username: string) => `user:${username}:nodes`;
const allUsersKey = () => 'users:active';

// ── Node CRUD ─────────────────────────────────────────────────────────────────

export async function createNode(
  username: string,
  type: NodeType,
  parentId: string | null,
  name: string,
  xpraPort?: number,
): Promise<SessionNode> {
  const nodeId = uuidv4();
  const node: SessionNode = {
    nodeId,
    parentId,
    username,
    type,
    name,
    createdAt: Date.now(),
    xpraPort,
  };

  await redis.set(nodeKey(nodeId), JSON.stringify(node));
  await redis.sadd(userNodesKey(username), nodeId);
  await redis.sadd(allUsersKey(), username);
  return node;
}

export async function getNode(nodeId: string): Promise<SessionNode | null> {
  const raw = await redis.get(nodeKey(nodeId));
  return raw ? (JSON.parse(raw) as SessionNode) : null;
}

export async function renameNode(nodeId: string, newName: string): Promise<void> {
  const node = await getNode(nodeId);
  if (!node) return;
  node.name = newName;
  await redis.set(nodeKey(nodeId), JSON.stringify(node));
}

export async function deleteNode(nodeId: string): Promise<void> {
  const node = await getNode(nodeId);
  if (!node) return;

  // Recursively delete all children first
  const children = await getChildNodes(nodeId);
  for (const child of children) {
    await deleteNode(child.nodeId);
  }

  await redis.del(nodeKey(nodeId));
  await redis.srem(userNodesKey(node.username), nodeId);

  // If user has no more nodes, remove from active users set
  const remaining = await redis.scard(userNodesKey(node.username));
  if (remaining === 0) {
    await redis.srem(allUsersKey(), node.username);
  }
}

export async function getUserNodes(username: string): Promise<SessionNode[]> {
  const ids = await redis.smembers(userNodesKey(username));
  const nodes: SessionNode[] = [];
  for (const id of ids) {
    const n = await getNode(id);
    if (n) nodes.push(n);
  }
  return nodes;
}

export async function getChildNodes(parentId: string): Promise<SessionNode[]> {
  const parent = await getNode(parentId);
  if (!parent) return [];
  const allNodes = await getUserNodes(parent.username);
  return allNodes.filter((n) => n.parentId === parentId);
}

export async function getAllActiveUsers(): Promise<string[]> {
  return redis.smembers(allUsersKey());
}

/**
 * Build a nested tree structure for a user's sessions.
 */
export interface TreeNode extends SessionNode {
  children: TreeNode[];
}

export async function buildUserTree(username: string): Promise<TreeNode[]> {
  const nodes = await getUserNodes(username);
  const map = new Map<string, TreeNode>();

  for (const n of nodes) {
    map.set(n.nodeId, { ...n, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const [, treeNode] of map) {
    if (treeNode.parentId === null) {
      roots.push(treeNode);
    } else {
      const parent = map.get(treeNode.parentId);
      if (parent) {
        parent.children.push(treeNode);
      } else {
        roots.push(treeNode); // orphan — treat as root
      }
    }
  }

  return roots;
}

export { redis };
