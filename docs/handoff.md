# Handoff: Court Tracker Dashboard

**Purpose:** Give a fresh agent enough context to plan implementation. This is a research handoff, not an implementation spec; do not start coding until the user confirms the plan and unresolved scope choices.

**Research snapshot:** 2026-10-30

## Problem and intended user experience

The user plays tennis in New York City, particularly Brooklyn, Queens, and Manhattan. During indoor season, they have to check multiple booking sites to find a court at a time that works (for example, 10 a.m. tomorrow). In outdoor permit season, they often use walk-on courts such as McCarren and want those retained as backup options.

The desired app is a **personal, read-only availability comparison tool**:

- Show selected courts/facilities from multiple booking providers together in a day or week calendar / time-slot grid.
- Let the user toggle which courts or facilities are shown and quickly compare availability at their preferred time.
- Clicking an available slot opens the provider's booking page. The app does not book, pay, cancel, or change reservations.
- Refresh schedules on an interval, roughly once per minute where the source and permission allow it. Show the last-checked time and handle stale/error states explicitly.
- Notifications for user-selected times becoming available are a possible later feature, not required for the first slice.
- Include permit-based walk-on courts as backup locations, but show them as **walk-on / live availability unknown**, never as confirmed open time.

The user states that they have explicit permission from the providers to scrape the sites for personal use. Treat this as an accepted constraint; confirm that the permission covers the selected refresh cadence and retention before implementing each connector.

## Decisions and direction established so far

1. **NYC is the initial geography.** Prioritize Brooklyn, Queens, and Manhattan; avoid a generic multi-city or multi-sport product in the first plan.
2. **Inventory discovery should be a bounded pre-step.** Seed the catalog from NYC Parks' tennis-facility directory and operator sites. Classify facilities before polling them; do not indiscriminately fetch every court page.
3. **Separate inventory from live schedules.** Keep a broad static catalog of courts, but poll only sources with time-specific bookable inventory. Walk-on public courts may remain visible as fallback destinations without live availability.
4. **A venue may have different booking modes by season.** Model distinct inventory/source records for a site's indoor bubble, outdoor permit courts, and any online-reservable subset. Do not treat all courts at one park as one schedule.
5. **Use one connector per booking system, not one connector per facility.** A source such as NYC Parks or AptusSoft appears to serve several facilities, while some venues use their own calendar or booking front end.
6. **Keep booking external.** The app is an availability view and link-out launcher only.
7. **Use a roughly one-minute refresh as the initial target**, subject to the approved cadence and measured load for each source. Stagger checks and avoid describing cached/stale data as current.
8. **Do not pick a tech stack yet.** The next agent should propose the architecture and thin implementation slices after validating the venue/source list and authentication needs.

## First-pass NYC venue and source inventory

The following are evidence-backed leads, not an exhaustive or fully verified catalog. “Likely source” means the official facility page identifies the booking portal or booking route; some still require validation with a user account.

| Facility / access mode | First-pass source | Evidence and caveats |
|---|---|---|
| NYC Parks online-reservable courts, including Central Park and Riverside locations | NYC Parks reservation system | Public pages render court-by-court times with statuses and “Reserve this time” links. Central Park lists six online-reservation courts; other parks have limited reservable courts. Citywide availability and reservation rules vary by site. [Reservations](https://www.nycgovparks.org/tennisreservation/) · [Central Park schedule](https://www.nycgovparks.org/tennisreservation/availability/12) · [Riverside schedule](https://www.nycgovparks.org/tennisreservation/availability/2) |
| Prospect Park Tennis Center, indoor rental season | AptusSoft | Official park page links to an online court booking portal; the portal presents an AptusSoft login. Outdoor permit courts are a separate access mode. [Facility information](https://www.prospectpark.org/visit-the-park/places-to-go/tennis-center/) · [Booking portal](https://prospectpark.aptussoft.com/member) |
| SPORTIME Randall's Island / JMTA | AptusSoft, plus NYC Parks for designated permit courts | Official SPORTIME site links its member/associate login to AptusSoft. NYC Parks lists a separate subset of permit courts there. [SPORTIME](https://www.sportimeny.com/manhattan) · [AptusSoft portal](https://sportime.aptussoft.com/member) |
| Cunningham Tennis, Queens | CatchCorner | Facility's official online-booking link opens a CatchCorner rental page. [Book a court](https://cunninghamtennis.com/book-court-online/) |
| USTA Billie Jean King National Tennis Center, Queens | CourtReserve | Official “Book a Court” page links to the USTA CourtReserve portal. Online reservations require a profile and waiver; booking window is currently described as two days. [Book a court](https://www.ntc.usta.com/book-a-court) |
| Commonpoint Tennis at Alley Pond, Queens | AccessBlume for indoor rentals; NYC Parks for outdoor permit/limited reservation access | Official tennis court-rental page links to AccessBlume. Seasonal outdoor courts are a separate mode. [Court rentals](https://commonpointtennis.org/court-rentals) · [NYC Parks facility directory](https://www.nycgovparks.org/facilities/tennis) |
| Sutton East / Queensboro Oval, Manhattan | NYC Parks for designated seasonal public courts; Sutton East public calendar plus phone booking for indoor club time | Sutton East publishes an “open court time” calendar but instructs players to call to reserve. Do not assume the calendar is a transactional live inventory until tested. [Court time](https://suttoneasttennis.com/courttime/) · [Calendar](https://suttoneasttennis.com/court-time-availability/) |
| Vanderbilt Tennis Club, Manhattan | Mindbody / “Tennis in Manhattan” | Official site exposes a seven-day availability finder and describes bookings through its Tennis in Manhattan app/Mindbody flow; prepaid credits are required. [Reservations](https://vanderbilttennisclub.com/online_reservations/) · [Availability finder](https://vanderbilttennisclub.com/appfinder/) |
| McCarren Park / McCarren Tennis Center, Brooklyn | NYC Parks for outdoor online-reservation subset; **indoor provider not yet confirmed** | NYC Parks lists two online-reservation courts and separately lists seven winter bubbled courts available for rental. The indoor center's public website did not reveal its booking destination in this research pass; get the exact URL from the user or facility. [NYC Parks reservations](https://www.nycgovparks.org/tennisreservation/) · [Court directory](https://www.nycgovparks.org/facilities/tennis) |
| Fort Greene Park, Brooklyn | Walk-on / permit fallback | NYC Parks lists six outdoor courts. No live time-slot booking schedule was found. Keep as a static fallback unless the user provides a separate reservable source. [NYC Parks court directory](https://www.nycgovparks.org/facilities/tennis) |
| MatchPoint NYC Bensonhurst, Brooklyn | Booking route still to verify | The operator offers indoor/outdoor tennis and court rentals; its official site links its app to Daxko Club Automation. Confirm whether hourly court availability is online and which portal exposes it before including it as a connector. [Bensonhurst facility](https://matchpoint.nyc/our-clubs/bensonhurst/) |

### Preliminary connector count

The initial named/priority venues point to approximately **six core platform families**: NYC Parks, AptusSoft, CatchCorner, CourtReserve, AccessBlume, and Mindbody. Add a small number of venue-specific calendar/custom cases (notably Sutton East and the still-unverified McCarren indoor bubble). This estimate is preliminary; it is not proof of complete NYC coverage.

### Seasonality

NYC Parks' online court reservation program runs roughly early April through November 15; rules and booking windows vary by site. Central Park has a longer advance booking window than most other city locations. Indoor bubbles and private club schedules become more important in fall/winter. Check source rules per inventory mode rather than applying one citywide season assumption. [NYC Parks program details](https://www.nycgovparks.org/tennisreservation/moreinfo)

## Suggested scope for the implementation-planning phase

Plan a first useful slice around a **curated set of 6–10 facilities** that the user can actually book this indoor season, selected to exercise the main source types. Candidate set:

- McCarren indoor (resolve booking URL/provider first)
- Prospect Park indoor (AptusSoft)
- Cunningham (CatchCorner)
- USTA Billie Jean King National Tennis Center (CourtReserve)
- Commonpoint Alley Pond (AccessBlume)
- SPORTIME Randall's Island (AptusSoft)
- Sutton East and/or Vanderbilt if their live schedule views are practical to read
- One NYC Parks schedule page as a separate, publicly visible source and outdoor-season baseline

Keep Fort Greene and other permit walk-on courts in the broader catalog as backup locations without fabricated slot data. Use the NYC Parks directory as the public-court seed; identify additional private/bookable facilities from operator booking pages and the user's preferred locations. Do not aim to scrape every court in the city in the first implementation.

## Product behavior to plan for

- Normalize schedule entries to facility, inventory/access mode, court (if exposed), start/end in **America/New_York**, availability status, booking URL, source, and `observed_at`.
- Distinguish at least: `available`, `booked/unavailable`, `not open for booking`, `unknown/stale`, and `walk-on (no live feed)`.
- Preserve provider-specific labels and requirements such as permit, profile, membership, or prepaid credit; a slot may be visible but not bookable by every user.
- Make freshness visible and link directly to the source schedule/reservation flow.
- Minimize stored data: availability only; no need for other players' identities or reservation details.
- Keep notifications out of the initial critical path; later alerts can fire on a transition to a matching available slot.

## Open questions for the user / planning agent

1. What is the exact McCarren indoor booking URL, and what account flow does the user already use there?
2. Which 6–10 facilities should be in the first watchlist? Should member-only facilities be included only where the user has an eligible account?
3. Should the first view emphasize a calendar grid, a “show me all courts free at 10 a.m.” comparison, or both?
4. Does “all NYC courts” mean every public court should appear in the static directory, while only online-bookable courts show live slots? This is the recommended interpretation.
5. Where will the polling worker run (personal computer, always-on home machine, or hosted service), and how should provider sessions/credentials be kept local and secure?
6. Confirm per-provider polling permission/rate and how often the user wants freshness; target is about once per minute where practical.

## Next agent's assignment

Start by turning this handoff into a short implementation plan. First validate the initial facility list and McCarren's indoor booking route; then propose a connector/data model and a vertical slice beginning with the lowest-friction source. Do not implement until the user approves the plan. Preserve the read-only/link-out boundary and the distinction between scheduled slots and walk-on fallbacks.
