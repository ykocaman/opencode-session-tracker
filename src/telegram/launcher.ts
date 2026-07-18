import { exec } from 'child_process';
import path from 'path';
import { readProjectPid } from './state';

export function launchOpenCodeInstance(targetDir: string, callback: (err: Error | null) => void) {
  // Security path check to prevent command injection
  if (/[\;&\|><\$\`\!]/.test(targetDir)) {
    return callback(new Error("Invalid characters in directory path"));
  }

  const platform = process.platform;
  let command = '';

  if (platform === 'darwin') {
    // macOS: Detect iTerm2 first. If running, open as a new tab in the active window. Otherwise, open a new window in Terminal app.
    const escPath = targetDir.replace(/"/g, '\\"');
    command = [
      `osascript`,
      `-e 'tell application "System Events" to set isITermRunning to exists (processes where name is "iTerm2")'`,
      `-e 'if isITermRunning then'`,
      `-e '  tell application "iTerm"'`,
      `-e '    if (count of windows) is 0 then'`,
      `-e '      create window with default profile'`,
      `-e '    else'`,
      `-e '      tell current window to create tab with default profile'`,
      `-e '    end if'`,
      `-e '    tell current session of current window to write text "cd \\"${escPath}\\" && opencode"'`,
      `-e '    activate'`,
      `-e '  end tell'`,
      `-e 'else'`,
      `-e '  tell application "Terminal"'`,
      `-e '    do script "cd \\"${escPath}\\" && opencode"'`,
      `-e '    activate'`,
      `-e '  end tell'`,
      `-e 'end if'`
    ].join(' ');
  } else if (platform === 'win32') {
    // Windows: Use cmd.exe to open a new Command Prompt window and run opencode
    const winPath = targetDir.replace(/\//g, '\\');
    command = `start cmd.exe /k "cd /d \\"${winPath}\\" && opencode"`;
  } else {
    // Linux / Ubuntu: Try gnome-terminal or xterm as fallback
    command = `gnome-terminal --working-directory="${targetDir}" -- opencode || xterm -e "cd \\"${targetDir}\\" && opencode"`;
  }

  exec(command, (err) => {
    callback(err);
  });
}

export function killOpenCodeInstance(targetDir: string, currentPid: number): { killed: boolean; message: string } {
  const pid = readProjectPid(targetDir);

  if (!pid) {
    return { killed: false, message: `⚠️ No active OpenCode instance found for ${path.basename(targetDir)}` };
  }

  if (pid === currentPid) {
    // Self-close: delay exit so the bot response sends first, then failover to another instance
    setTimeout(() => process.exit(0), 2000);
    return { killed: true, message: `✅ Closed OpenCode in ${path.basename(targetDir)}` };
  }

  try {
    process.kill(pid, 'SIGTERM');
    return { killed: true, message: `✅ Closed OpenCode in ${path.basename(targetDir)}` };
  } catch {
    return { killed: false, message: `⚠️ Failed to close OpenCode in ${path.basename(targetDir)} (already exited?)` };
  }
}
