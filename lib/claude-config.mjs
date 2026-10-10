import os from 'node:os';
import path from 'node:path';

// Claude Code 允許用 CLAUDE_CONFIG_DIR 把 ~/.claude 整個搬走；settings.json 與 projects/ 都跟著搬
export function getClaudeConfigDirectory(environment = process.env) {
  const configuredDirectory = environment.CLAUDE_CONFIG_DIR;
  if (typeof configuredDirectory === 'string' && configuredDirectory !== '') {
    return configuredDirectory;
  }
  const homeDirectory = typeof environment.HOME === 'string' && environment.HOME !== '' ? environment.HOME : os.homedir();
  return path.join(homeDirectory, '.claude');
}

export function getClaudeProjectsDirectory(environment = process.env) {
  return path.join(getClaudeConfigDirectory(environment), 'projects');
}

export function getClaudeSettingsPath(environment = process.env) {
  return path.join(getClaudeConfigDirectory(environment), 'settings.json');
}
