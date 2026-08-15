'use strict';

/**
 * Locates the external tools the framework adapters shell out to.
 *
 * Node-based suites (Playwright, Cypress) are self-contained: their CLI lives in
 * the suite's own node_modules and we spawn it with the same Node that runs the
 * dashboard. JVM suites are not — `java` and `mvn` are frequently installed
 * without ever being put on PATH (which is the case on this machine), so rather
 * than failing with "mvn: not found" we look in the usual places.
 *
 * Every lookup can be overridden with an env var, and results are cached for the
 * life of the process.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const cache = new Map();
function once(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

const isWin = process.platform === 'win32';
const exe = (name) => (isWin ? `${name}.exe` : name);

/** First existing path from a list of candidates (globs expanded one level). */
function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (!c.includes('*')) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    // Single `*` segment: list the parent and try each match, newest name last.
    const star = c.indexOf('*');
    const parent = path.dirname(c.slice(0, star));
    const tailStart = c.indexOf(path.sep, star) < 0 ? c.length : c.indexOf(path.sep, star);
    const pattern = c.slice(path.dirname(c.slice(0, star)).length + 1, tailStart);
    const tail = c.slice(tailStart);
    let entries;
    try {
      entries = fs.readdirSync(parent);
    } catch (_) {
      continue;
    }
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const matches = entries.filter((e) => re.test(e)).sort();
    for (const m of matches.reverse()) {
      const full = path.join(parent, m) + tail;
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

/** Look up a bare command name on PATH. */
function onPath(command) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = isWin ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

/* ----------------------------------- Java --------------------------------- */

/** JDK home (the directory containing bin/java), or null. */
function javaHome() {
  return once('javaHome', () => {
    if (process.env.DASHBOARD_JAVA_HOME) return process.env.DASHBOARD_JAVA_HOME;
    if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin', exe('java')))) {
      return process.env.JAVA_HOME;
    }
    const found = firstExisting([
      path.join('C:', 'Program Files', 'Eclipse Adoptium', 'jdk-*', 'bin', exe('java')),
      path.join('C:', 'Program Files', 'Java', 'jdk-*', 'bin', exe('java')),
      path.join('C:', 'Program Files', 'Microsoft', 'jdk-*', 'bin', exe('java')),
      path.join('C:', 'Program Files', 'Amazon Corretto', 'jdk*', 'bin', exe('java')),
      path.join(os.homedir(), '.jdks', '*', 'bin', exe('java')),
      '/usr/lib/jvm/default-java/bin/java',
    ]);
    if (found) return path.dirname(path.dirname(found));
    const viaPath = onPath('java');
    return viaPath ? path.dirname(path.dirname(viaPath)) : null;
  });
}

/** Absolute path to the java launcher, or null. */
function javaExe() {
  const home = javaHome();
  return home ? path.join(home, 'bin', exe('java')) : null;
}

/* ---------------------------------- Maven --------------------------------- */

/** Maven install root (the directory containing bin/ and boot/), or null. */
function mavenHome() {
  return once('mavenHome', () => {
    const explicit = process.env.DASHBOARD_MAVEN_HOME || process.env.MAVEN_HOME || process.env.M2_HOME;
    if (explicit && fs.existsSync(path.join(explicit, 'bin', 'm2.conf'))) return explicit;
    const found = firstExisting([
      path.join(os.homedir(), 'tools', 'apache-maven-*', 'bin', 'm2.conf'),
      path.join(os.homedir(), 'apache-maven-*', 'bin', 'm2.conf'),
      path.join(os.homedir(), 'scoop', 'apps', 'maven', 'current', 'bin', 'm2.conf'),
      path.join('C:', 'Program Files', 'Apache', 'maven*', 'bin', 'm2.conf'),
      path.join('C:', 'apache-maven-*', 'bin', 'm2.conf'),
      path.join('C:', 'tools', 'apache-maven-*', 'bin', 'm2.conf'),
      '/usr/share/maven/bin/m2.conf',
      '/opt/maven/bin/m2.conf',
    ]);
    if (found) return path.dirname(path.dirname(found));
    // `mvn` on PATH is usually <home>/bin/mvn.
    const viaPath = onPath('mvn');
    if (viaPath) {
      const home = path.dirname(path.dirname(viaPath));
      if (fs.existsSync(path.join(home, 'bin', 'm2.conf'))) return home;
    }
    return null;
  });
}

/**
 * Build a Maven invocation as a direct `java` launch of Maven's classworlds
 * bootstrapper — exactly what bin/mvn.cmd does internally.
 *
 * The point of bypassing mvn.cmd is quoting: spawning a .cmd on Windows means
 * spawning through a shell, and this project lives under a path with a space in
 * it ("AI Projects"), which is precisely where shell quoting goes wrong. Going
 * straight to java keeps argv an array with no shell in the middle.
 *
 * Returns { command, args } or null when Java/Maven can't be found.
 */
function mavenCommand(mavenArgs, { projectDir } = {}) {
  const home = mavenHome();
  const java = javaExe();
  if (!home || !java) return null;

  const bootDir = path.join(home, 'boot');
  let classworlds;
  try {
    const jar = fs.readdirSync(bootDir).find((f) => /^plexus-classworlds.*\.jar$/.test(f));
    classworlds = jar ? path.join(bootDir, jar) : null;
  } catch (_) {
    classworlds = null;
  }
  if (!classworlds) return null;

  return {
    command: java,
    args: [
      '-classpath', classworlds,
      `-Dclassworlds.conf=${path.join(home, 'bin', 'm2.conf')}`,
      `-Dmaven.home=${home}`,
      `-Dlibrary.jansi.path=${path.join(home, 'lib', 'jansi-native')}`,
      `-Dmaven.multiModuleProjectDirectory=${projectDir || process.cwd()}`,
      'org.codehaus.plexus.classworlds.launcher.Launcher',
      ...mavenArgs,
    ],
  };
}

module.exports = { javaHome, javaExe, mavenHome, mavenCommand, onPath };
