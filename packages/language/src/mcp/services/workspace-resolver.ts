/**
 * Workspace Resolution and Path Utilities
 * 
 * Centralized handling of workspace paths and file resolution.
 * Supports both absolute and relative paths, with smart resolution against workspace root.
 */

import * as path from 'path';
import * as fs from 'fs';
import { URI } from 'langium';

/**
 * Get the workspace root directory.
 * 
 * Priority:
 * 1. --workspace CLI argument (passed via MCP server args)
 * 2. OML_WORKSPACE_ROOT environment variable
 * 3. Common workspace environment variables from host integrations
 * 4. Current working directory as fallback
 * 
 * @returns The workspace root path (absolute)
 */
export function getWorkspaceRoot(): string {
    const args = process.argv;

    // Support both "--workspace <path>" and "--workspace=<path>"
    const wsIdx = args.indexOf('--workspace');
    if (wsIdx !== -1 && wsIdx + 1 < args.length) {
        const value = sanitizeWorkspacePath(args[wsIdx + 1]);
        if (isUsableWorkspaceRoot(value)) {
            return value;
        }
    }

    const wsEqualsArg = args.find(arg => arg.startsWith('--workspace='));
    if (wsEqualsArg) {
        const value = sanitizeWorkspacePath(wsEqualsArg.slice('--workspace='.length));
        if (isUsableWorkspaceRoot(value)) {
            return value;
        }
    }

    const envRoot = sanitizeWorkspacePath(process.env.OML_WORKSPACE_ROOT);
    if (isUsableWorkspaceRoot(envRoot)) {
        return envRoot;
    }

    const hostWorkspaceVars = [
        process.env.MCP_WORKSPACE_ROOT,
        process.env.VSCODE_WORKSPACE_ROOT,
        process.env.WORKSPACE_ROOT,
        process.env.WORKSPACE_FOLDER,
    ];
    for (const candidate of hostWorkspaceVars) {
        const root = sanitizeWorkspacePath(candidate);
        if (isUsableWorkspaceRoot(root)) {
            return root;
        }
    }

    // Some hosts set one of these even when cwd points to the home directory
    const pwdRoot = sanitizeWorkspacePath(process.env.PWD);
    if (isUsableWorkspaceRoot(pwdRoot)) {
        return pwdRoot;
    }

    const initCwdRoot = sanitizeWorkspacePath(process.env.INIT_CWD);
    if (isUsableWorkspaceRoot(initCwdRoot)) {
        return initCwdRoot;
    }

    return process.cwd();
}

function sanitizeWorkspacePath(input?: string): string | undefined {
    if (!input) {
        return undefined;
    }

    const trimmed = input.trim().replace(/^['\"]|['\"]$/g, '');
    return trimmed.length > 0 ? trimmed : undefined;
}

function isUsableWorkspaceRoot(input?: string): input is string {
    return Boolean(input && input.length > 1 && fs.existsSync(input));
}

/**
 * Set the workspace root (useful for testing).
 * 
 * @param root The new workspace root path
 */
export function setWorkspaceRoot(root: string): void {
    process.env.OML_WORKSPACE_ROOT = root;
}

/**
 * Resolve a file path relative to the workspace root.
 * 
 * - If the path is already absolute, returns it as-is
 * - If relative, resolves against the workspace root (not cwd)
 * - Normalizes the path (handles .. and .)
 * 
 * @param inputPath Path (absolute or relative)
 * @returns Resolved absolute path
 */
export function resolveWorkspacePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
        return path.normalize(inputPath);
    }
    const workspaceRoot = getWorkspaceRoot();
    return path.resolve(workspaceRoot, inputPath);
}

/**
 * Get the relative path from workspace root.
 * Useful for displaying paths to users.
 * 
 * @param absolutePath Absolute file path
 * @returns Relative path from workspace root, using forward slashes
 */
export function getRelativeWorkspacePath(absolutePath: string): string {
    const workspaceRoot = getWorkspaceRoot();
    const relative = path.relative(workspaceRoot, absolutePath);
    // Normalize to forward slashes for consistency
    return relative.replace(/\\/g, '/');
}

/**
 * Convert a file path to a file:// URI.
 * 
 * @param filePath Absolute file path or file:// URI
 * @returns file:// URI
 */
export function pathToFileUri(filePath: string): string {
    if (filePath.startsWith('file://')) {
        return filePath;
    }
    const absolutePath = resolveWorkspacePath(filePath);
    return URI.file(absolutePath).toString();
}

/**
 * Convert a file:// URI to an absolute file path.
 * 
 * @param fileUri file:// URI
 * @returns Absolute file path
 */
export function fileUriToPath(fileUri: string): string {
    return URI.parse(fileUri).fsPath;
}

/**
 * Verify that a file exists.
 * 
 * @param filePath Absolute file path
 * @throws Error if file doesn't exist
 */
export function ensureFileExists(filePath: string): void {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found at ${filePath}`);
    }
}

/**
 * Verify that a file is in the workspace.
 * 
 * @param filePath Absolute file path
 * @throws Error if file is outside workspace
 */
export function ensureInWorkspace(filePath: string): void {
    const workspaceRoot = getWorkspaceRoot();
    const relative = path.relative(workspaceRoot, filePath);
    if (relative.startsWith('..')) {
        throw new Error(`File is outside workspace: ${filePath}`);
    }
}

/**
 * Get file stats with readable size.
 * 
 * @param filePath Absolute file path
 * @returns File size information
 */
export function getFileSize(filePath: string): { bytes: number; readable: string } {
    const stats = fs.statSync(filePath);
    const bytes = stats.size;
    const kb = Math.round(bytes / 1024 * 10) / 10;
    return {
        bytes,
        readable: kb > 1 ? `${kb}KB` : `${bytes}B`
    };
}

/**
 * Get the modification time of a file.
 * 
 * @param filePath Absolute file path
 * @returns Modification timestamp in milliseconds
 */
export function getFileModTime(filePath: string): number {
    return fs.statSync(filePath).mtimeMs;
}

/**
 * Detect end-of-line style in a text file.
 * 
 * @param content File content
 * @returns '\r\n' (Windows) or '\n' (Unix)
 */
export function detectEol(content: string): '\r\n' | '\n' {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Detect indentation style used in a file.
 * 
 * @param content File content
 * @returns The indentation string (usually spaces or tabs)
 */
export function detectIndentation(content: string): string {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/^( +|\t+)/);
        if (match) return match[1];
    }
    return '    '; // Default to 4 spaces
}

/**
 * Find a file by name, searching up the directory tree.
 * Useful for finding methodology shape files, config files, etc.
 * 
 * @param startPath Starting directory or file
 * @param fileName Name of file to find
 * @param maxDepth Maximum directory depth to search (default: 10)
 * @returns Path to found file, or null if not found
 */
export function findFileInAncestors(
    startPath: string,
    fileName: string,
    maxDepth: number = 10
): string | null {
    let current = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
    
    for (let depth = 0; depth < maxDepth; depth++) {
        const candidate = path.join(current, fileName);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
        
        const parent = path.dirname(current);
        if (parent === current) {
            // Reached filesystem root
            break;
        }
        current = parent;
    }
    
    return null;
}

/**
 * Find all OML files in a directory (recursive).
 * 
 * @param dirPath Directory to search
 * @param ignoreNodeModules Skip node_modules and build directories (default: true)
 * @returns Array of absolute file paths
 */
export function findOmlFiles(
    dirPath: string,
    ignoreNodeModules: boolean = true
): string[] {
    const results: string[] = [];
    
    function walk(dir: string) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                if (ignoreNodeModules && (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build')) {
                    continue;
                }
                
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.oml')) {
                    results.push(fullPath);
                }
            }
        } catch {
            // Skip unreadable directories
        }
    }
    
    walk(dirPath);
    return results;
}
