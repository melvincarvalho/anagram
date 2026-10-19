# Social card

`card.html` is the source of `../og-image.png` (1200×630, used for Open Graph and
Twitter/X previews). To regenerate after editing it:

```sh
python3 -m http.server 39901 &   # serve this folder
chromium --headless=new --hide-scrollbars --window-size=1200,630 \
  --virtual-time-budget=6000 --screenshot=$HOME/card.png http://127.0.0.1:39901/card.html
magick $HOME/card.png -strip -define png:compression-level=9 ../og-image.png
```

The card loads Inter from Google Fonts at render time only; the app itself does not.
