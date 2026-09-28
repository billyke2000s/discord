# tools/

`Tv-1.18.2-patched.java` is the YouTube plugin's TV client (youtube-source 1.18.2, MIT licence) with one change:
it identifies as a Samsung Tizen smart TV (user agent, clientVersion, deviceMake/deviceModel/osName/osVersion),
the fix yt-dlp found for YouTube's "The page needs to be reloaded" error.

`Tv-1.18.2-patched.class.b64` is that file compiled (Java 8 bytecode, same as the original).
install.sh downloads the official youtube-plugin-1.18.2.jar from GitHub, checks its SHA-256,
and swaps in this one class. Nothing else in the plugin is changed.

When an official plugin version newer than 1.18.2 fixes the TV client, this patch can be dropped.

## License

`Tv-1.18.2-patched.java` / `.class.b64` are a modified file from
[lavalink-devs/youtube-source](https://github.com/lavalink-devs/youtube-source), which is MIT licensed:

> MIT License — Copyright (c) 2024 devoxin
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of
> the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

