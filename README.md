# IntelliComp Lead Search

A browser userscript that adds a **Generate leads** panel to IntelliComp (exmod.com). You log in yourself, load a contractor list, press **Run**, and it looks each contractor up one at a time in your session, the same way you would by hand:

1. Searches IntelliComp by company name (it drops "Inc", "LLC", "DBA ..." so the search matches like yours does).
2. Compares the address of each result to the address on your list (city, street number, street name).
3. If one result clearly matches, it opens that bureau report and records the data. If it isn't sure, it puts the contractor in a **Pick the right company** list in the panel, where you choose the right result (or "None of these").
4. When you're done, **Download results** gives you your original list plus the IntelliComp columns below.

Nothing runs unless you press Run, and it waits between page loads (3 seconds by default) so it doesn't overload IntelliComp's server.

## Install (once)

1. Install the **Tampermonkey** extension in Chrome.
2. In Chrome, open `chrome://extensions`, click **Details** on Tampermonkey and turn on **Allow User Scripts** (newer Chrome versions require this).
3. Open the Tampermonkey dashboard, go to **Utilities**, and under *Import from file* choose `intellicomp-lead-search.user.js`. (Or click the **+** tab and paste the file's contents, then File → Save.)
4. Log in to IntelliComp. The **Generate leads** panel appears in the bottom-right corner.

To update later, repeat step 3 with the new file.

## Your contractor list

A CSV with a header row. It works directly with the CSLB master list columns, or a simple list of your own. Column names it recognizes:

| What | Recognized column names |
|---|---|
| Company name (required) | BusinessName, FullBusinessName, Company, Name |
| Street address | MailingAddress, Address, Street |
| City | City |
| ZIP | ZIPCode, Zip |
| License # | LicenseNo, License Number, License |
| Phone | BusinessPhone, Phone |

Filter the CSLB list down to your counties and trades before loading it; the full master list is hundreds of thousands of rows. **Rows this run** limits how many it does per session, and the rest stay queued. Progress is saved, so if you close the tab or IntelliComp logs you out, log back in and press **Run** to continue.

## Columns added to your results

| Column | Meaning |
|---|---|
| ic_status | found, needs review, not found, skipped (no name), or error |
| ic_mod_rated | **Yes** if the risk has an active ex mod for this year or next year, otherwise **No** |
| ic_mod_2027 … ic_mod_2023 | the active ex mod for each of the last 5 mod years (column years move forward each calendar year; blank = no mod that year) |
| ic_how_matched | which address details matched, "only result", or "you picked" |
| ic_license_check | whether IntelliComp's CSLB tab shows the same license # as your list |
| ic_wcirb, ic_wcirb_name, ic_wcirb_address | WCIRB bureau number, names and address |
| ic_contact, ic_contact_title, ic_phone | contact from the WCIRB file |
| ic_current_mod_year, ic_current_mod, ic_prior_mod, ic_mod_change | newest active ex mod (e.g. 1.14), the one before it, and the change |
| ic_mod_status | e.g. (N) New Entry, (R) Revised Entry |
| ic_projected_effective | projected renewal months |
| ic_class_codes | current WCIRB class codes |
| ic_wc_insurer, ic_wc_policy, ic_wc_effective, ic_wc_expiration | workers' comp policy from the Contractor's Licence Data tab |
| ic_mod_review_link | personalized link to the mod-review landing page (name, company, city, phone, and the **Mailer tag** as `src`) |
| ic_candidates | for unresolved rows, the results it found |

## Settings

At the top of the script (`CONFIG`): landing page address, default seconds between lookups, default rows per run, and how strong an address match must be before it picks a result without asking (`autoMatchScore`; city = 2, street number = 2, street name = 1, exact name = 1).
