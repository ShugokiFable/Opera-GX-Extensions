# _Deploy

Double-click `Build.cmd`.

It validates every extension in this repo, signs a `.crx` and `.zip` for each
into `..\Release\`, writes checksums, and reports what your browser is running
against what it just built.

Private signing keys live in `keys\` and are gitignored. Back that folder up.
If one goes missing the next build mints a replacement and says so; the only
cost is removing the old extension card once.

Full documentation is in the [repository README](../README.md).
