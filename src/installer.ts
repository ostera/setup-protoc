// Load tempDirectory before it gets wiped by tool-cache
let tempDirectory = process.env["RUNNER_TEMP"] || "";

import * as os from "os";
import * as path from "path";
import * as util from "util";
import * as restm from "typed-rest-client/RestClient";
import * as semver from "semver";
import { uuidV4 } from "uuid/v4";

if (!tempDirectory) {
  let baseLocation;
  if (process.platform === "win32") {
    // On windows use the USERPROFILE env variable
    baseLocation = process.env["USERPROFILE"] || "C:\\";
  } else {
    if (process.platform === "darwin") {
      baseLocation = "/Users";
    } else {
      baseLocation = "/home";
    }
  }
  tempDirectory = path.join(baseLocation, "actions", "temp");
}

import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import * as exc from "@actions/exec";
import * as io from "@actions/io";

let osPlat: string = os.platform();
let osArch: string = os.arch();

interface IProtocRelease {
  tag_name: string;
  prerelease: boolean;
}

export async function getProtoc(
  version: string,
  includePreReleases: boolean,
  repoToken: string,
) {
  // resolve the version number
  // const targetVersion = await computeVersion(
  //   version,
  //   includePreReleases,
  //   repoToken,
  // );
  // if (targetVersion) {
  //   version = targetVersion;
  // }
  process.stdout.write("Getting protoc version: " + version + os.EOL);

  // look if the binary is cached
  let toolPath: string;
  toolPath = tc.find("protoc", version);

  // if not: download, extract and cache
  if (!toolPath) {
    toolPath = await downloadRelease(version);
    process.stdout.write("Protoc cached under " + toolPath + os.EOL);
  }

  // add the bin folder to the PATH
  toolPath = path.join(toolPath, "bin");
  core.addPath(toolPath);

  // make available Go-specific compiler to the PATH,
  // this is needed because of https://github.com/actions/setup-go/issues/14

  const goBin: string = await io.which("go", false);
  if (goBin) {
    // Go is installed, add $GOPATH/bin to the $PATH because setup-go
    // doesn't do it for us.
    let stdOut = "";
    let options = {
      listeners: {
        stdout: (data: Buffer) => {
          stdOut += data.toString();
        },
      },
    };

    await exc.exec("go", ["env", "GOPATH"], options);
    const goPath: string = stdOut.trim();
    core.debug("GOPATH: " + goPath);

    core.addPath(path.join(goPath, "bin"));
  }
}

async function downloadRelease(version: string): Promise<string> {
  // Download
  let fileName: string = getFileName(version, osPlat, osArch);
  let downloadUrl: string = util.format(
    "https://github.com/protocolbuffers/protobuf/releases/download/%s/%s",
    version,
    fileName,
  );
  process.stdout.write("Downloading archive: " + downloadUrl + os.EOL);

  let downloadPath: string | null = null;
  try {
    downloadPath = await tc.downloadTool(downloadUrl);
  } catch (error) {
    core.debug(error);
    throw `Failed to download version ${version}: ${error}`;
  }

  process.stdout.write("Extracting archive at " + downloadPath + os.EOL);
  // Extract
  let extPath: string = downloadPath + "-extracted";
  await io.mkdirP(extPath);
  process.stdout.write("Extracting archive at " + extPath + os.EOL);
  await exc.exec(`unzip`, [downloadPath], {cwd: extPath});

  process.stdout.write("Caching archive..." + os.EOL);

  // Install into the local tool cache - node extracts with a root folder that matches the fileName downloaded
  let cachePath = await tc.cacheDir(extPath, "protoc", version);
  process.stdout.write("Cached archive at " + cachePath + os.EOL);

  return cachePath
}

/**
 * @param osArch - A string identifying the operating system platform for which the Node.js binary was compiled.
 * See https://nodejs.org/api/os.html#osplatform for possible values.
 * @returns Suffix for the protoc filename.
 */
function fileNameSuffix(osArch: string): string {
  switch (osArch) {
    case "x64": {
      return "x86_64";
    }
    case "arm64": {
      return "aarch_64";
    }
    case "s390x": {
      return "s390_64";
    }
    case "ppc64": {
      return "ppcle_64";
    }
    default: {
      return "x86_32";
    }
  }
}

/**
 * Returns the filename of the protobuf compiler.
 *
 * @param version - The version to download
 * @param osPlat - The operating system platform for which the Node.js binary was compiled.
 * See https://nodejs.org/api/os.html#osplatform for more.
 * @param osArch - The operating system CPU architecture for which the Node.js binary was compiled.
 * See https://nodejs.org/api/os.html#osplatform for more.
 * @returns The filename of the protocol buffer for the given release, platform and architecture.
 */
export function getFileName(
  version: string,
  osPlat: string,
  osArch: string,
): string {
  // to compose the file name, strip the leading `v` char
  if (version.startsWith("v")) {
    version = version.slice(1, version.length);
  }

  // The name of the Windows package has a different naming pattern
  if (osPlat == "win32") {
    const arch: string = osArch == "x64" ? "64" : "32";
    return util.format("protoc-%s-win%s.zip", version, arch);
  }

  const suffix = fileNameSuffix(osArch);

  if (osPlat == "darwin") {
    return util.format("protoc-%s-osx-%s.zip", version, suffix);
  }

  return util.format("protoc-%s-linux-%s.zip", version, suffix);
}

// Retrieve a list of versions scraping tags from the Github API
async function fetchVersions(
  includePreReleases: boolean,
  repoToken: string,
): Promise<string[]> {
  let rest: restm.RestClient;
  if (repoToken != "") {
    rest = new restm.RestClient("setup-protoc", "", [], {
      headers: { Authorization: "Bearer " + repoToken },
    });
  } else {
    rest = new restm.RestClient("setup-protoc");
  }

  let tags: IProtocRelease[] = [];
  for (let pageNum = 1, morePages = true; morePages; pageNum++) {
    let nextPage: IProtocRelease[] = (await rest.get<IProtocRelease[]>(
      "https://api.github.com/repos/protocolbuffers/protobuf/releases?page=" +
        pageNum,
    )).result || [];
    if (nextPage.length > 0) {
      tags = tags.concat(nextPage);
    } else {
      morePages = false;
    }
  }

  return tags
    .filter((tag) => tag.tag_name.match(/v\d+\.[\w\.]+/g))
    .filter((tag) => includePrerelease(tag.prerelease, includePreReleases))
    .map((tag) => tag.tag_name.replace("v", ""));
}

// Compute an actual version starting from the `version` configuration param.
async function computeVersion(
  version: string,
  includePreReleases: boolean,
  repoToken: string,
): Promise<string> {
  // strip leading `v` char (will be re-added later)
  if (version.startsWith("v")) {
    version = version.slice(1, version.length);
  }

  // strip trailing .x chars
  if (version.endsWith(".x")) {
    version = version.slice(0, version.length - 2);
  }

  const allVersions = await fetchVersions(includePreReleases, repoToken);
  const validVersions = allVersions.filter((v) => semver.valid(v));
  const possibleVersions = validVersions.filter((v) => v.startsWith(version));

  const versionMap = new Map();
  possibleVersions.forEach((v) => versionMap.set(normalizeVersion(v), v));

  const versions = Array.from(versionMap.keys())
    .sort(semver.rcompare)
    .map((v) => versionMap.get(v));

  core.debug(`evaluating ${versions.length} versions`);

  if (versions.length === 0) {
    throw new Error("unable to get latest version");
  }

  core.debug(`matched: ${versions[0]}`);

  return "v" + versions[0];
}

// Make partial versions semver compliant.
function normalizeVersion(version: string): string {
  const preStrings = ["beta", "rc", "preview"];

  const versionPart = version.split(".");
  // drop invalid
  if (versionPart[1] == null) {
    //append minor and patch version if not available
    // e.g. 2 -> 2.0.0
    return version.concat(".0.0");
  } else {
    // handle beta and rc
    // e.g. 1.10beta1 -? 1.10.0-beta1, 1.10rc1 -> 1.10.0-rc1
    if (preStrings.some((el) => versionPart[1].includes(el))) {
      versionPart[1] = versionPart[1]
        .replace("beta", ".0-beta")
        .replace("rc", ".0-rc")
        .replace("preview", ".0-preview");
      return versionPart.join(".");
    }
  }

  if (versionPart[2] == null) {
    //append patch version if not available
    // e.g. 2.1 -> 2.1.0
    return version.concat(".0");
  } else {
    // handle beta and rc
    // e.g. 1.8.5beta1 -> 1.8.5-beta1, 1.8.5rc1 -> 1.8.5-rc1
    if (preStrings.some((el) => versionPart[2].includes(el))) {
      versionPart[2] = versionPart[2]
        .replace("beta", "-beta")
        .replace("rc", "-rc")
        .replace("preview", "-preview");
      return versionPart.join(".");
    }
  }

  return version;
}

function includePrerelease(
  isPrerelease: boolean,
  includePrereleases: boolean,
): boolean {
  return includePrereleases || !isPrerelease;
}
