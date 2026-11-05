# Torn Mini Happy Jump Helper

A Tampermonkey userscript that tracks a five-step Mini Happy Jump routine, inventory counts, and the OD insurance timer.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the userscript's [raw GitHub URL](https://raw.githubusercontent.com/jascheri/Torn-Mini-Happy-Jump-Helper/main/torn-mini-happy-jump-helper.user.js) and install it in Tampermonkey.

If you already installed a copy by pasting the code manually, replace it once with the raw GitHub version so Tampermonkey gets the update and download URLs.

## Updates

The script declares GitHub's `main` branch raw URL as both its update and download source. Tampermonkey checks for updates on its configured schedule; a push does not update the script immediately. Increment the userscript `@version` for every published change so Tampermonkey can detect it.

The checklist displays Xanax's 360–480 minute cooldown and Ecstasy's 200–231 minute cooldown. These are ranges.

## Live cooldown and energy (optional API key)

Click ⚙️ in the header and paste a Torn API key (Minimal access is enough). The script then calls `https://api.torn.com/v2/user/cooldowns` and `/user/bars` once a minute and shows a live drug-cooldown countdown and time until energy is full. The key is stored locally in Tampermonkey (separate from the jump data), is sent only to `api.torn.com`, and can be removed from the same screen. Without a key, wait until Torn shows the cooldown has cleared.

## Inventory sync

On `item.php`, the script waits for the inventory rows to stop changing, then reads visible item rows with `data-item` and `data-qty` attributes. This is a bounded one-time scan with no `MutationObserver`. Use **[Sync]** to retry if the automatic scan times out. A successful scan replaces tracked counts with the quantities it finds; confirm the counts in Torn if the inventory page only rendered part of your inventory.
