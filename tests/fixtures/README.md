# Test fixtures

`books.json` holds the verses the core's tests read, 46 in all, as the import tool (`bindings/js/import.mjs`) has them:

| Books | Edition | Source | License |
| --- | --- | --- | --- |
| jonah, psalms | World English Bible | [eBible.org](https://ebible.org) | public domain |
| jonah-de, matthew-de | Luther 1912 | eBible.org | public domain |
| jonah-ar | Smith & Van Dyck | eBible.org | public domain |
| jonah-he, psalms-he | Westminster Leningrad Codex | [Open Scriptures Hebrew Bible](https://github.com/openscriptures/morphhb) | text public domain; its notes on the KJV's numbering CC BY 4.0 |
| matthew-el | SBL Greek New Testament | eBible.org | CC BY 4.0 |
| quran-1, quran-2 | Tanzil Uthmani 1.0.2 | [tanzil.net](http://tanzil.net) | CC BY 3.0, below |
| quran-1, quran-2: tajweed rules | quran-tajweed | [cpfair/quran-tajweed](https://github.com/cpfair/quran-tajweed) | CC BY 4.0 |

Changes made by the import: the SBLGNT's apparatus signs are left out. The Hebrew's paragraph signs and the editors' notes are left out, and the two forms of a word written one way and read another are marked. The basmala opening Al-Baqarah stands as a verse of its own, verse 0. The Quran text itself is unchanged.

The SBLGNT: Copyright © 2010 by the Society of Biblical Literature and Logos Bible Software.

Tanzil's notice, as its terms ask:

```
#  Tanzil Quran Text (Uthmani, version 1.0.2)
#  Copyright (C) 2008-2010 Tanzil.net
#  License: Creative Commons Attribution 3.0
#
#  This copy of quran text is carefully produced, highly
#  verified and continuously monitored by a group of specialists
#  at Tanzil project.
#
#  TERMS OF USE:
#
#  - Permission is granted to copy and distribute verbatim copies
#    of this text, but CHANGING IT IS NOT ALLOWED.
#
#  - This quran text can be used in any website or application,
#    provided its source (Tanzil.net) is clearly indicated, and
#    a link is made to http://tanzil.net to enable users to keep
#    track of changes.
#
#  - This copyright notice shall be included in all verbatim copies
#    of the text, and shall be reproduced appropriately in all files
#    derived from or containing substantial portion of this text.
#
#  Please check updates at: http://tanzil.net/updates/
```
