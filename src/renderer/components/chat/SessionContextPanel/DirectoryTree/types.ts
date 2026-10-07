/**
 * Type definitions for DirectoryTree components.
 */

export interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  tokens?: number;
  firstSeenInGroup?: string;
  firstSeenTurnIndex?: number;
  children: Map<string, TreeNode>;
}
