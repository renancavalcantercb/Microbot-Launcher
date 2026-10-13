# Third-party notices

## Java runtime embedded in the installer

The Microbot Cut Launcher installer carries a reduced Java 17 runtime, so no one has to install a JDK.
It is **Eclipse Temurin**, built by the Eclipse Adoptium project from OpenJDK, and it is not a product of
Microbot Cut. "Java" and "Temurin" are trademarks of their owners.

| Item | Value |
|---|---|
| Supplier | Eclipse Adoptium, Eclipse Temurin 17 (HotSpot), Windows x64 |
| Release | `jdk-17.0.20.1+1` |
| Archive | `OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip`, SHA-256 `e53a79c3c3d86865bd7e787903884331068e71321714ffd44f145785affc7cb0` |
| Verified against | the pinned digest, the publisher's checksum file, and the publisher's GPG signature (key fingerprint `3B04D753C9050D9A5D343F39843C48A565F8F04B`) |
| OpenJDK source | `adoptium/jdk17u` commit `79597447bd94ff9f8216e2e3a573d5261ee49f2e` |
| Build recipe | `adoptium/temurin-build` commit `e6ba7dec3d07654074559310376a3ae89da5f4ac` |
| Reduction | `jlink --strip-debug --no-header-files --no-man-pages --compress=2` with the modules listed in `config/java-runtime.json` |

License: the GNU General Public License, version 2, **with the Classpath Exception** (OpenJDK). The licenses
and notices of the runtime are installed with it, inside the application folder:

- `resources\java-runtime\NOTICE` (Eclipse Temurin notices)
- `resources\java-runtime\legal\<module>\` (`LICENSE`, `ASSEMBLY_EXCEPTION`, `ADDITIONAL_LICENSE_INFO` and the
  third-party licenses of each included module)

Source: the OpenJDK source for this build is the `jdk17u` commit above, public at
<https://github.com/adoptium/jdk17u>. The Temurin binaries are published at
<https://github.com/adoptium/temurin17-binaries>.

The runtime is never modified by the launcher. Its files are verified against `runtime-manifest.json` before
every client start; see "Embedded Java runtime" in `README.md`.
