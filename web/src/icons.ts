// Local Phosphor barrel: deep per-icon imports so the ~100 icons the app uses
// tree-shake into the entry chunk. Importing named icons from the
// '@phosphor-icons/react' barrel does NOT tree-shake (rollup can't prune it),
// which previously dragged the ENTIRE ~6MB library into the entry. Each
// 'dist/csr/<Name>' import pulls a single icon file. The FULL set (for the
// by-name icon picker) is reachable ONLY via the lazy dynamic import in
// utils/phosphorIcons, so it splits into its own on-demand chunk.
//
// To add an icon for direct use: add its export line here, then import it
// from '.../icons' like before.

export type { Icon } from '@phosphor-icons/react/dist/lib/types';

export { ArrowBendUpRightIcon } from '@phosphor-icons/react/dist/csr/ArrowBendUpRight';
export { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
export { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
export { ArrowLineLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLineLeft';
export { ArrowLineRightIcon } from '@phosphor-icons/react/dist/csr/ArrowLineRight';
export { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight';
export { ArrowSquareInIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareIn';
export { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
export { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
export { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
export { ArrowsLeftRightIcon } from '@phosphor-icons/react/dist/csr/ArrowsLeftRight';
export { ArrowsMergeIcon } from '@phosphor-icons/react/dist/csr/ArrowsMerge';
export { ArrowsOutIcon } from '@phosphor-icons/react/dist/csr/ArrowsOut';
export { BellRingingIcon } from '@phosphor-icons/react/dist/csr/BellRinging';
export { BinocularsIcon } from '@phosphor-icons/react/dist/csr/Binoculars';
export { BookmarkSimpleIcon } from '@phosphor-icons/react/dist/csr/BookmarkSimple';
export { BroadcastIcon } from '@phosphor-icons/react/dist/csr/Broadcast';
export { BroomIcon } from '@phosphor-icons/react/dist/csr/Broom';
export { BuildingsIcon } from '@phosphor-icons/react/dist/csr/Buildings';
export { CardsIcon } from '@phosphor-icons/react/dist/csr/Cards';
export { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
export { CaretLeftIcon } from '@phosphor-icons/react/dist/csr/CaretLeft';
export { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
export { CaretUpIcon } from '@phosphor-icons/react/dist/csr/CaretUp';
export { ChartBarIcon } from '@phosphor-icons/react/dist/csr/ChartBar';
export { ChartDonutIcon } from '@phosphor-icons/react/dist/csr/ChartDonut';
export { ChartLineIcon } from '@phosphor-icons/react/dist/csr/ChartLine';
export { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
export { ClipboardTextIcon } from '@phosphor-icons/react/dist/csr/ClipboardText';
export { ClockCountdownIcon } from '@phosphor-icons/react/dist/csr/ClockCountdown';
export { ClockIcon } from '@phosphor-icons/react/dist/csr/Clock';
export { ColumnsIcon } from '@phosphor-icons/react/dist/csr/Columns';
export { CommandIcon } from '@phosphor-icons/react/dist/csr/Command';
export { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy';
export { CrosshairIcon } from '@phosphor-icons/react/dist/csr/Crosshair';
export { CrosshairSimpleIcon } from '@phosphor-icons/react/dist/csr/CrosshairSimple';
export { DiamondsFourIcon } from '@phosphor-icons/react/dist/csr/DiamondsFour';
export { DiscordLogoIcon } from '@phosphor-icons/react/dist/csr/DiscordLogo';
export { DotsSixVerticalIcon } from '@phosphor-icons/react/dist/csr/DotsSixVertical';
export { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye';
export { EyeglassesIcon } from '@phosphor-icons/react/dist/csr/Eyeglasses';
export { FireIcon } from '@phosphor-icons/react/dist/csr/Fire';
export { FlagBannerIcon } from '@phosphor-icons/react/dist/csr/FlagBanner';
export { FootprintsIcon } from '@phosphor-icons/react/dist/csr/Footprints';
export { GaugeIcon } from '@phosphor-icons/react/dist/csr/Gauge';
export { GraphIcon } from '@phosphor-icons/react/dist/csr/Graph';
export { HandshakeIcon } from '@phosphor-icons/react/dist/csr/Handshake';
export { HashIcon } from '@phosphor-icons/react/dist/csr/Hash';
export { HourglassIcon } from '@phosphor-icons/react/dist/csr/Hourglass';
export { HouseIcon } from '@phosphor-icons/react/dist/csr/House';
export { IdentificationCardIcon } from '@phosphor-icons/react/dist/csr/IdentificationCard';
export { ImageIcon } from '@phosphor-icons/react/dist/csr/Image';
export { KeyIcon } from '@phosphor-icons/react/dist/csr/Key';
export { LightningIcon } from '@phosphor-icons/react/dist/csr/Lightning';
export { LineSegmentsIcon } from '@phosphor-icons/react/dist/csr/LineSegments';
export { LinkBreakIcon } from '@phosphor-icons/react/dist/csr/LinkBreak';
export { LinkSimpleIcon } from '@phosphor-icons/react/dist/csr/LinkSimple';
export { ListPlusIcon } from '@phosphor-icons/react/dist/csr/ListPlus';
export { LockIcon } from '@phosphor-icons/react/dist/csr/Lock';
export { LockOpenIcon } from '@phosphor-icons/react/dist/csr/LockOpen';
export { MagnetIcon } from '@phosphor-icons/react/dist/csr/Magnet';
export { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
export { MapPinIcon } from '@phosphor-icons/react/dist/csr/MapPin';
export { MapPinSimpleIcon } from '@phosphor-icons/react/dist/csr/MapPinSimple';
export { MapTrifoldIcon } from '@phosphor-icons/react/dist/csr/MapTrifold';
export { NavigationArrowIcon } from '@phosphor-icons/react/dist/csr/NavigationArrow';
export { PathIcon } from '@phosphor-icons/react/dist/csr/Path';
export { PlanetIcon } from '@phosphor-icons/react/dist/csr/Planet';
export { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
export { ProhibitIcon } from '@phosphor-icons/react/dist/csr/Prohibit';
export { PulseIcon } from '@phosphor-icons/react/dist/csr/Pulse';
export { QuestionIcon } from '@phosphor-icons/react/dist/csr/Question';
export { SelectionAllIcon } from '@phosphor-icons/react/dist/csr/SelectionAll';
export { SelectionIcon } from '@phosphor-icons/react/dist/csr/Selection';
export { ShieldCheckIcon } from '@phosphor-icons/react/dist/csr/ShieldCheck';
export { ShieldStarIcon } from '@phosphor-icons/react/dist/csr/ShieldStar';
export { SidebarIcon } from '@phosphor-icons/react/dist/csr/Sidebar';
export { SignOutIcon } from '@phosphor-icons/react/dist/csr/SignOut';
export { SkullIcon } from '@phosphor-icons/react/dist/csr/Skull';
export { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal';
export { SnowflakeIcon } from '@phosphor-icons/react/dist/csr/Snowflake';
export { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
export { SquaresFourIcon } from '@phosphor-icons/react/dist/csr/SquaresFour';
export { StackIcon } from '@phosphor-icons/react/dist/csr/Stack';
export { StarIcon } from '@phosphor-icons/react/dist/csr/Star';
export { SunIcon } from '@phosphor-icons/react/dist/csr/Sun';
export { SwordIcon } from '@phosphor-icons/react/dist/csr/Sword';
export { TableIcon } from '@phosphor-icons/react/dist/csr/Table';
export { TagIcon } from '@phosphor-icons/react/dist/csr/Tag';
export { TargetIcon } from '@phosphor-icons/react/dist/csr/Target';
export { TextAaIcon } from '@phosphor-icons/react/dist/csr/TextAa';
export { TimerIcon } from '@phosphor-icons/react/dist/csr/Timer';
export { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash';
export { UserGearIcon } from '@phosphor-icons/react/dist/csr/UserGear';
export { UsersIcon } from '@phosphor-icons/react/dist/csr/Users';
export { UsersThreeIcon } from '@phosphor-icons/react/dist/csr/UsersThree';
export { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
export { WaveformIcon } from '@phosphor-icons/react/dist/csr/Waveform';
export { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
export { XIcon } from '@phosphor-icons/react/dist/csr/X';
