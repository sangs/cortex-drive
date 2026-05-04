"""
Date utility: parse career date strings into epoch integers and derived properties.

This module is the single authoritative parser for all date formats used
in the CortexDrive resume graph seeder. It converts human-readable date
strings from categories_and_projects.md into structured properties that
are written to both relationship edges (source of truth) and project nodes
(denormalized cache for efficient querying).

Episode nodes use aired_date only — never call parse_date_range or
parse_single_date for Episode node properties. The fields produced here
(displayDate, startYear, endYear) are career-node concepts and must not
be written to Episode nodes.

Supported formats:
  - "mm/yyyy"             : e.g., "02/2024"
  - "mm/yyyy-mm/yyyy"     : e.g., "02/2024-07/2025"
  - "mm/yyyy-Present"     : e.g., "08/2025-Present"
  - "yyyy"                : e.g., "2014"  (treated as Jan-Dec of that year)
  - "Present"             : active/current (endEpoch = 999999 sentinel)

PEP 8 compliant, fully documented per code-style-guide.
"""

import re
from typing import Optional

# Sentinel value for "Present" / active entries.
# 999999 sorts higher than any real yyyyMM epoch, ensuring present-active
# entries always appear at the top of ORDER BY endEpoch DESC queries.
PRESENT_SENTINEL = 999999


def _to_epoch(date_str: str, is_end: bool = False) -> Optional[int]:
    """
    Convert a single date string token to a yyyyMM integer epoch.

    Args:
        date_str: A date string such as "02/2024", "Present", or "2014".
        is_end:   True if this is an end date — affects yyyy-only treatment
                  (startEpoch uses January=01, endEpoch uses December=12).

    Returns:
        An integer yyyyMM epoch (e.g., 202402), 999999 for "Present",
        or None if the string cannot be parsed.
    """
    if not date_str:
        return None

    val = date_str.strip()

    # Handle "Present" / "PRESENT" / "present" / "active" / "current"
    if val.lower() in ("present", "active", "current"):
        return PRESENT_SENTINEL

    # Handle "mm/yyyy" format — e.g., "02/2024" → 202402
    mm_yyyy = re.match(r"^(\d{1,2})/(\d{4})$", val)
    if mm_yyyy:
        month = int(mm_yyyy.group(1))
        year = int(mm_yyyy.group(2))
        return year * 100 + month

    # Handle "yyyy" standalone format — e.g., "2014"
    # Year-only dates span the full year: Jan for start, Dec for end.
    yyyy = re.match(r"^(\d{4})$", val)
    if yyyy:
        year = int(yyyy.group(1))
        return year * 100 + (12 if is_end else 1)

    return None


def parse_date_range(start_str: str, end_str: str) -> dict:
    """
    Parse a start/end date pair into all derived properties for the graph.

    This is the primary function used by the seeder. Both the relationship
    (source of truth) and the connected node (denormalized cache) receive
    these properties.

    Args:
        start_str: Start date string (e.g., "02/2024", "2013", "08/1997").
        end_str:   End date string (e.g., "07/2025", "Present", "2021").

    Returns:
        A dict with all derived properties:
          - startEpoch  (int)  : yyyyMM integer, e.g., 202402
          - endEpoch    (int)  : yyyyMM integer or 999999 for Present
          - isPresent   (bool) : True only if end_str is "Present"
          - displayDate (str)  : Raw "{start}-{end}" string for UI rendering
          - startYear   (str)  : 4-digit year of start, e.g., "2024"
          - endYear     (str)  : 4-digit year of end, or "Present"

    Example:
        >>> parse_date_range("02/2024", "07/2025")
        {
            "startEpoch": 202402,
            "endEpoch": 202507,
            "isPresent": False,
            "displayDate": "02/2024-07/2025",
            "startYear": "2024",
            "endYear": "2025"
        }

        >>> parse_date_range("08/2025", "Present")
        {
            "startEpoch": 202508,
            "endEpoch": 999999,
            "isPresent": True,
            "displayDate": "08/2025-Present",
            "startYear": "2025",
            "endYear": "Present"
        }
    """
    start_epoch = _to_epoch(start_str, is_end=False)
    end_epoch = _to_epoch(end_str, is_end=True)
    is_present = (end_str is not None and end_str.strip().lower() == "present")

    # Extract 4-digit year strings for range filtering in UI
    start_year = _extract_year_str(start_str)
    end_year = "Present" if is_present else _extract_year_str(end_str)

    display_date = f"{start_str}-{end_str}" if (start_str and end_str) else (start_str or end_str or "")

    return {
        "startEpoch": start_epoch,
        "endEpoch": end_epoch,
        "isPresent": is_present,
        "displayDate": display_date,
        "startYear": start_year,
        "endYear": end_year,
    }


def parse_single_date(date_str: str) -> dict:
    """
    Parse a single-value date (e.g., year: "2025" on a hackathon node).

    Used for nodes where only a single year or date is given without a range.
    Treats the value as both start and end (full year span for yyyy format).

    Args:
        date_str: A date string such as "2025", "01/2026", or "Present".

    Returns:
        Same dict shape as parse_date_range, with start == end.
    """
    return parse_date_range(date_str, date_str)


def _extract_year_str(date_str: str) -> Optional[str]:
    """
    Extract the 4-digit year as a string from a date string.

    Args:
        date_str: Any date string format.

    Returns:
        A 4-character year string like "2024", or None if not found.
    """
    if not date_str:
        return None
    match = re.search(r"(\d{4})", date_str)
    return match.group(1) if match else None
