# Wasfaty Autofill

`Wasfaty Autofill` is a Chrome extension that helps speed up medication entry and refill work on Wasfaty by using saved profiles, favorite drugs, refill extraction from previous prescriptions, and controlled automation.

Programmed by **Dr. Moosa Hakami**  
**Consultant Family Medicine & Diabetologist**

## What the project does

- Saves reusable medication profiles in Chrome local storage.
- Supports both `Standard Medication` and `Special Medication` profiles.
- Can auto-fill drug forms after a drug is selected.
- Lets you keep up to 10 favorite drugs for quick popup use.
- Extracts drugs from an old prescription into the popup `Refill Box`.
- Supports refill using saved profiles or temporary profiles built from old prescription instructions.

## Chrome installation
[![Wasfaty AutoFill Tutorial](https://thumbs.video-to-markdown.com/b7cabe17.jpg)](https://youtu.be/_npCOoiTB20)

To use the extension in Chrome:

1. Open Chrome and go to `chrome://extensions/`
2. Turn on **Developer mode** from the top-right corner.
3. Click **Load unpacked**
4. Select the extension folder
<img width="1920" height="1040" alt="2" src="https://github.com/user-attachments/assets/7b7bc93e-a339-4ddd-89e1-20ce21d97180" />

After loading:

1. Pin the extension from the Chrome extensions menu if needed
2. Open Wasfaty
3. Use the popup for quick actions or open the `Profiles` page to manage saved profiles
<img width="1920" height="1040" alt="3" src="https://github.com/user-attachments/assets/fabd30f0-5708-4595-9857-41026216b606" />

## Profile page guide

The `Profiles` page is the local control center for the extension.

### Settings

- **Auto Detect**: turns automatic profile fill on or off when a selected drug changes on the Wasfaty page.
- **Auto-Focus Drug**: moves focus to the next drug field after saving, to speed up repeated entry.
- **Entry Speed**: controls how fast the automation types and fills fields.
- **Show Favorites in Popup**: shows or hides the `Favorite Drugs` section in the popup.
- **Refill Box**: shows or hides the `Refill Box` section in the popup.
- **Refill Without Profile**: allows refill of drugs that do not already have a saved profile by creating a temporary profile from the old prescription.
- **Use Prescription Temp for All**: ignores saved profiles during refill and builds temporary profiles from the previous prescription for all extracted refill drugs.
- **Special temp duration fallback (max value)**: used only for special temporary refill profiles when the old prescription does not provide a usable duration. If left empty, refill pauses so the user can type duration manually.
- **Save Settings**: stores all current settings to Chrome local storage.

### Create / Edit

This section is used to create a new profile or edit an existing one.

- **Profile Name**: display name of the saved profile.
- **Drug Code**: matching code used to find the profile during fill/refill.
- **Profile Type**: chooses between `Standard Medication` and `Special Medication`.

For `Standard Medication`:

- **Take**: dose value entered in the main drug instruction line.
- **Times**: number of times per day/week/month.
- **Every**: interval value.
- **Day Type**: unit for the interval, such as `Day`, `Week`, or `Month`.
- **For (Duration)**: total duration.
- **Dose Timing**: timing option such as `Before Meals`, `After Meals`, `In the Morning`, and similar timing values.
- **Refills**: refill count.
- **Click Add after fill**: tells automation to press the Wasfaty `Add` button after filling.

For `Special Medication`:

- **Special Instructions**: written into the special instructions textarea on Wasfaty.
- **Total Quantity**: written into the quantity field for special medication.
- **Duration**: duration for the special medication.
- **Refills**: refill count for the special medication.
- **Click Add after fill**: tells automation to press the Wasfaty `Add` button after filling.

Action buttons in this section:

- **Save**: stores the current profile.
- **Reset form**: clears the form and exits edit mode.
- **Delete ALL Profiles**: removes every saved profile from local storage.

### Favorite Drugs

- **Favorite Drugs (Max 10)**: lets you choose up to 10 saved drug codes to show in the popup.
- **Deselect all**: removes all favorite selections.
- **Selected count**: shows how many favorite drugs are currently selected.

### Saved Profiles

This section shows all saved profiles and tools for managing them.

- **Drug count**: total number of saved profiles.
- **Refresh**: reloads profiles from storage.
- **Export JSON**: downloads all saved profiles as a JSON file.
- **Import JSON**: restores profiles from a JSON file.
- **Per page**: controls how many profiles are shown on one page.
- **Sort by name**: sorts profiles from `A to Z` or `Z to A`.
- **Search profiles**: filters profiles by name, code, type, or summary text.
- **Prev / Next**: moves between profile pages.
- **Table columns**:
  - `Name`: profile display name
  - `Match`: stored drug code
  - `Type`: standard or special
  - `Summary`: quick summary of the saved profile data
  - `Add?`: shows whether `Click Add after fill` is enabled
  - `Actions`: edit or delete a single profile

## Notes

- Profiles are stored locally in Chrome storage.
- The extension is designed for Wasfaty workflow support, so UI behavior depends on the current Wasfaty page structure.
- If Chrome does not reflect your latest code changes, reload the extension from `chrome://extensions/`.
