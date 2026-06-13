// Wormhole reference data for the WH-type chart modal (a Nexum take on
// whtype.info). Bundled static data — wormhole types change at most once an
// expansion. "Level" (sig_level / scanning difficulty) is intentionally omitted.
//
// Each entry connects a wormhole code to the value(s) it occupies in each
// column; the chart draws lines from a hovered code to those values.

export type Respawn  = 'Static' | 'Wandering' | 'Reverse';
export type ShipSize =
  | 'up to Destroyer' | 'up to Battlecruiser' | 'up to Battleship'
  | 'up to Freighter' | 'up to Capital';

export interface WhChartEntry {
  wormhole:  string;
  respawn:   Respawn[];
  spawn_in:  string[];
  leads_to:  string[];
  ship_size: ShipSize | null;
  total_mass: string | null;
  life_time:  string | null;
}

// Canonical, ordered value lists per column (drives the row order in the UI).
export const RESPAWN_ORDER: Respawn[] = ['Static', 'Wandering', 'Reverse'];

export const SPAWN_ORDER: string[] = [
  'Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6',
  'HighSec', 'LowSec', 'NullSec',
  'Class 12 - Thera', 'Class 13 - Shattered', 'Pochven ▲ Trig space',
  'Drone Regions', 'Drifter wormholes', 'Jove Observatories', 'never spawn', 'EXIT',
];

export const LEADS_ORDER: string[] = [
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'HS', 'LS', 'NS', 'Thera', 'C13', 'Pochven',
  'Sentinel MZ', 'Liberated Barbican', 'Sanctified Vidette', 'Conflux Eyrie', 'Azdaja Redoubt',
  'drifter blackhole', 'jump to identify',
];

export const SHIP_ORDER: ShipSize[] = [
  'up to Destroyer', 'up to Battlecruiser', 'up to Battleship', 'up to Freighter', 'up to Capital',
];

export const MASS_ORDER: string[] = [
  '100 000 000 kg', '500 000 000 kg', '750 000 000 kg',
  '1 000 000 000 kg', '2 000 000 000 kg', '3 000 000 000 kg', '3 300 000 000 kg', '5 000 000 000 kg',
];

export const LIFE_ORDER: string[] = ['4.5h', '12h', '16h', '24h', '48h'];

export const WH_CHART: WhChartEntry[] = [
  { wormhole: 'A009', respawn: ['Wandering'], spawn_in: ['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6', 'NullSec', 'Class 12 - Thera', 'Class 13 - Shattered'], leads_to: ['C13'], ship_size: 'up to Destroyer', total_mass: '3 000 000 000 kg', life_time: '4.5h' },
  { wormhole: 'A239', respawn: ['Static'], spawn_in: ['Class 2'], leads_to: ['LS'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '24h' },
  { wormhole: 'A641', respawn: ['Wandering'], spawn_in: ['HighSec'], leads_to: ['HS'], ship_size: 'up to Freighter', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'A982', respawn: ['Wandering'], spawn_in: ['Class 3', 'Class 12 - Thera'], leads_to: ['C6'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'B041', respawn: ['Wandering'], spawn_in: ['HighSec'], leads_to: ['C6'], ship_size: 'up to Freighter', total_mass: '3 000 000 000 kg', life_time: '48h' },
  { wormhole: 'B274', respawn: ['Static', 'Wandering'], spawn_in: ['Class 2'], leads_to: ['HS'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '24h' },
  { wormhole: 'B449', respawn: ['Wandering'], spawn_in: ['LowSec', 'NullSec'], leads_to: ['HS'], ship_size: 'up to Freighter', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'B520', respawn: ['Wandering'], spawn_in: ['Class 6'], leads_to: ['HS'], ship_size: 'up to Freighter', total_mass: '3 000 000 000 kg', life_time: '48h' },
  { wormhole: 'B735', respawn: ['Wandering'], spawn_in: ['HighSec', 'LowSec', 'NullSec', 'Jove Observatories'], leads_to: ['Liberated Barbican'], ship_size: 'up to Battleship', total_mass: '750 000 000 kg', life_time: '16h' },
  { wormhole: 'C008', respawn: ['Wandering'], spawn_in: ['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6', 'Class 12 - Thera', 'Class 13 - Shattered'], leads_to: ['C5'], ship_size: 'up to Destroyer', total_mass: '3 000 000 000 kg', life_time: '4.5h' },
  { wormhole: 'C125', respawn: ['Wandering'], spawn_in: ['Class 1'], leads_to: ['C2'], ship_size: 'up to Battlecruiser', total_mass: '1 000 000 000 kg', life_time: '16h' },
  { wormhole: 'C140', respawn: ['Wandering'], spawn_in: ['Class 5', 'Class 6'], leads_to: ['LS'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '24h' },
  { wormhole: 'C247', respawn: ['Static', 'Wandering'], spawn_in: ['Class 4'], leads_to: ['C3'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'C248', respawn: ['Wandering'], spawn_in: ['Class 6'], leads_to: ['NS'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '24h' },
  { wormhole: 'C391', respawn: ['Wandering'], spawn_in: ['Class 6'], leads_to: ['LS'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '48h' },
  { wormhole: 'C414', respawn: ['Wandering'], spawn_in: ['HighSec', 'LowSec', 'NullSec', 'Jove Observatories'], leads_to: ['Conflux Eyrie'], ship_size: 'up to Battleship', total_mass: '750 000 000 kg', life_time: '16h' },
  { wormhole: 'C729', respawn: ['Static'], spawn_in: ['Pochven ▲ Trig space'], leads_to: ['HS', 'LS', 'NS'], ship_size: 'up to Freighter', total_mass: '1 000 000 000 kg', life_time: '12h' },
  { wormhole: 'D364', respawn: ['Static'], spawn_in: ['Class 5'], leads_to: ['C2'], ship_size: 'up to Battleship', total_mass: '1 000 000 000 kg', life_time: '16h' },
  { wormhole: 'D382', respawn: ['Static', 'Wandering'], spawn_in: ['Class 2', 'Drifter wormholes'], leads_to: ['C2'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'D792', respawn: ['Wandering'], spawn_in: ['Class 5', 'Class 6'], leads_to: ['HS'], ship_size: 'up to Freighter', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'D845', respawn: ['Static'], spawn_in: ['Class 3'], leads_to: ['HS'], ship_size: 'up to Battleship', total_mass: '5 000 000 000 kg', life_time: '24h' },
  { wormhole: 'E004', respawn: ['Wandering'], spawn_in: ['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6', 'Class 12 - Thera', 'Class 13 - Shattered'], leads_to: ['C1'], ship_size: 'up to Destroyer', total_mass: '3 000 000 000 kg', life_time: '4.5h' },
  { wormhole: 'E175', respawn: ['Static', 'Wandering'], spawn_in: ['Class 5'], leads_to: ['C4'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'E545', respawn: ['Static'], spawn_in: ['Class 2'], leads_to: ['NS'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'E587', respawn: ['Static'], spawn_in: ['Class 12 - Thera'], leads_to: ['NS'], ship_size: 'up to Freighter', total_mass: '3 000 000 000 kg', life_time: '16h' },
  { wormhole: 'F135', respawn: ['Wandering', 'Reverse'], spawn_in: ['Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6'], leads_to: ['Thera'], ship_size: 'up to Battleship', total_mass: '750 000 000 kg', life_time: '16h' },
  { wormhole: 'F216', respawn: ['Wandering', 'Reverse'], spawn_in: ['Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6'], leads_to: ['Pochven'], ship_size: 'up to Battleship', total_mass: '1 000 000 000 kg', life_time: '12h' },
  { wormhole: 'F353', respawn: ['Wandering', 'Reverse'], spawn_in: ['Class 1'], leads_to: ['Thera'], ship_size: 'up to Battlecruiser', total_mass: '100 000 000 kg', life_time: '16h' },
  { wormhole: 'G008', respawn: ['Wandering'], spawn_in: ['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6', 'Class 12 - Thera', 'Class 13 - Shattered'], leads_to: ['C6'], ship_size: 'up to Destroyer', total_mass: '3 000 000 000 kg', life_time: '4.5h' },
  { wormhole: 'G024', respawn: ['Static'], spawn_in: ['Class 6'], leads_to: ['C2'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'H121', respawn: ['Wandering'], spawn_in: ['Class 1'], leads_to: ['C1'], ship_size: 'up to Battlecruiser', total_mass: '500 000 000 kg', life_time: '16h' },
  { wormhole: 'H296', respawn: ['Static', 'Wandering'], spawn_in: ['Class 5'], leads_to: ['C5'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '24h' },
  { wormhole: 'H900', respawn: ['Static', 'Wandering'], spawn_in: ['Class 4'], leads_to: ['C5'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'I078', respawn: [], spawn_in: ['Pochven ▲ Trig space'], leads_to: ['Pochven'], ship_size: 'up to Battlecruiser', total_mass: '100 000 000 kg', life_time: '4.5h' },
  { wormhole: 'I182', respawn: ['Wandering'], spawn_in: ['Class 3', 'Class 12 - Thera'], leads_to: ['C2'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'J244', respawn: ['Static'], spawn_in: ['Class 1'], leads_to: ['LS'], ship_size: 'up to Battlecruiser', total_mass: '1 000 000 000 kg', life_time: '24h' },
  { wormhole: 'J377', respawn: ['Wandering', 'Reverse'], spawn_in: ['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 12 - Thera'], leads_to: ['LS'], ship_size: 'up to Battlecruiser', total_mass: '1 000 000 000 kg', life_time: '24h' },
  { wormhole: 'J492', respawn: ['Wandering', 'Reverse'], spawn_in: ['Class 1', 'Class 2', 'Class 3', 'Class 4'], leads_to: ['LS'], ship_size: 'up to Battlecruiser', total_mass: '1 000 000 000 kg', life_time: '24h' },
  { wormhole: 'K329', respawn: ['Wandering'], spawn_in: ['Class 4'], leads_to: ['NS'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '16h' },
  { wormhole: 'K346', respawn: ['Static'], spawn_in: ['Class 3'], leads_to: ['NS'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '16h' },
  { wormhole: 'L005', respawn: ['Wandering'], spawn_in: ['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6', 'Class 12 - Thera', 'Class 13 - Shattered'], leads_to: ['C2'], ship_size: 'up to Destroyer', total_mass: '3 000 000 000 kg', life_time: '4.5h' },
  { wormhole: 'L031', respawn: ['Wandering', 'Reverse'], spawn_in: ['NullSec'], leads_to: ['Thera'], ship_size: 'up to Freighter', total_mass: '3 000 000 000 kg', life_time: '16h' },
  { wormhole: 'L477', respawn: ['Static'], spawn_in: ['Class 6'], leads_to: ['C3'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'L614', respawn: ['Wandering'], spawn_in: ['Class 1', 'NullSec'], leads_to: ['C5'], ship_size: 'up to Battlecruiser', total_mass: '1 000 000 000 kg', life_time: '24h' },
  { wormhole: 'L687', respawn: [], spawn_in: ['Pochven ▲ Trig space'], leads_to: ['Pochven'], ship_size: 'up to Battlecruiser', total_mass: '100 000 000 kg', life_time: '4.5h' },
  { wormhole: 'M001', respawn: ['Wandering'], spawn_in: ['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6', 'Class 12 - Thera', 'Class 13 - Shattered'], leads_to: ['C4'], ship_size: 'up to Destroyer', total_mass: '3 000 000 000 kg', life_time: '4.5h' },
  { wormhole: 'M164', respawn: ['Wandering', 'Reverse'], spawn_in: ['LowSec'], leads_to: ['Thera'], ship_size: 'up to Freighter', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'M267', respawn: ['Static'], spawn_in: ['Class 5'], leads_to: ['C3'], ship_size: 'up to Battleship', total_mass: '1 000 000 000 kg', life_time: '16h' },
  { wormhole: 'M555', respawn: ['Wandering'], spawn_in: ['HighSec'], leads_to: ['C5'], ship_size: 'up to Freighter', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'M609', respawn: ['Wandering'], spawn_in: ['Class 1'], leads_to: ['C4'], ship_size: 'up to Battlecruiser', total_mass: '1 000 000 000 kg', life_time: '16h' },
  { wormhole: 'N062', respawn: ['Static', 'Wandering'], spawn_in: ['Class 2', 'Drifter wormholes'], leads_to: ['C5'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'N110', respawn: ['Static'], spawn_in: ['Class 1'], leads_to: ['HS'], ship_size: 'up to Battlecruiser', total_mass: '1 000 000 000 kg', life_time: '24h' },
  { wormhole: 'N290', respawn: ['Wandering'], spawn_in: ['Class 4'], leads_to: ['LS'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'N432', respawn: ['Wandering'], spawn_in: ['LowSec', 'NullSec'], leads_to: ['C5'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '24h' },
  { wormhole: 'N766', respawn: ['Static'], spawn_in: ['Class 4'], leads_to: ['C2'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'N770', respawn: ['Wandering'], spawn_in: ['Class 3', 'Class 12 - Thera'], leads_to: ['C5'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'N944', respawn: ['Wandering'], spawn_in: ['LowSec', 'NullSec'], leads_to: ['LS'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '24h' },
  { wormhole: 'N968', respawn: ['Wandering'], spawn_in: ['Class 3', 'Class 12 - Thera'], leads_to: ['C3'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'O128', respawn: ['Wandering'], spawn_in: ['HighSec', 'LowSec', 'NullSec', 'never spawn'], leads_to: ['C4'], ship_size: 'up to Battleship', total_mass: '1 000 000 000 kg', life_time: '24h' },
  { wormhole: 'O477', respawn: ['Static', 'Wandering'], spawn_in: ['Class 2', 'Drifter wormholes'], leads_to: ['C3'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'O546', respawn: [], spawn_in: ['Pochven ▲ Trig space'], leads_to: ['Pochven'], ship_size: 'up to Battlecruiser', total_mass: '100 000 000 kg', life_time: '4.5h' },
  { wormhole: 'O883', respawn: ['Wandering'], spawn_in: ['Class 1', 'NullSec'], leads_to: ['C3'], ship_size: 'up to Battlecruiser', total_mass: '1 000 000 000 kg', life_time: '16h' },
  { wormhole: 'P060', respawn: ['Static'], spawn_in: ['Class 4'], leads_to: ['C1'], ship_size: 'up to Battlecruiser', total_mass: '500 000 000 kg', life_time: '16h' },
  { wormhole: 'Q003', respawn: ['Wandering'], spawn_in: ['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6', 'Class 12 - Thera', 'Class 13 - Shattered'], leads_to: ['NS'], ship_size: 'up to Destroyer', total_mass: '3 000 000 000 kg', life_time: '4.5h' },
  { wormhole: 'Q063', respawn: ['Static'], spawn_in: ['Class 12 - Thera'], leads_to: ['HS'], ship_size: 'up to Battlecruiser', total_mass: '500 000 000 kg', life_time: '16h' },
  { wormhole: 'Q317', respawn: ['Static'], spawn_in: ['Class 6'], leads_to: ['C1'], ship_size: 'up to Battlecruiser', total_mass: '500 000 000 kg', life_time: '16h' },
  { wormhole: 'R051', respawn: ['Wandering'], spawn_in: ['HighSec'], leads_to: ['LS'], ship_size: 'up to Freighter', total_mass: '3 000 000 000 kg', life_time: '16h' },
  { wormhole: 'R081', respawn: ['Wandering'], spawn_in: ['Pochven ▲ Trig space'], leads_to: ['C4'], ship_size: 'up to Battleship', total_mass: '1 000 000 000 kg', life_time: '12h' },
  { wormhole: 'R259', respawn: ['Wandering'], spawn_in: ['HighSec', 'LowSec', 'NullSec', 'Jove Observatories'], leads_to: ['Azdaja Redoubt'], ship_size: 'up to Battleship', total_mass: '750 000 000 kg', life_time: '16h' },
  { wormhole: 'R474', respawn: ['Static', 'Wandering'], spawn_in: ['Class 2', 'Drifter wormholes'], leads_to: ['C6'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'R943', respawn: ['Wandering'], spawn_in: ['HighSec', 'LowSec', 'NullSec'], leads_to: ['C2'], ship_size: 'up to Battleship', total_mass: '750 000 000 kg', life_time: '16h' },
  { wormhole: 'S047', respawn: ['Wandering'], spawn_in: ['Class 4'], leads_to: ['HS'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'S199', respawn: ['Wandering'], spawn_in: ['LowSec', 'NullSec'], leads_to: ['NS'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '24h' },
  { wormhole: 'S804', respawn: ['Wandering'], spawn_in: ['Class 1', 'NullSec'], leads_to: ['C6'], ship_size: 'up to Battlecruiser', total_mass: '1 000 000 000 kg', life_time: '24h' },
  { wormhole: 'S877', respawn: ['Wandering'], spawn_in: ['HighSec', 'LowSec', 'NullSec', 'Jove Observatories'], leads_to: ['Sentinel MZ'], ship_size: 'up to Battleship', total_mass: '750 000 000 kg', life_time: '16h' },
  { wormhole: 'T405', respawn: ['Wandering'], spawn_in: ['Class 3', 'Class 12 - Thera'], leads_to: ['C4'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'T458', respawn: ['Wandering', 'Reverse'], spawn_in: ['HighSec'], leads_to: ['Thera'], ship_size: 'up to Battlecruiser', total_mass: '500 000 000 kg', life_time: '16h' },
  { wormhole: 'U210', respawn: ['Static'], spawn_in: ['Class 3'], leads_to: ['LS'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'U319', respawn: ['Wandering'], spawn_in: ['LowSec', 'NullSec'], leads_to: ['C6'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '48h' },
  { wormhole: 'U372', respawn: ['Wandering', 'Reverse'], spawn_in: ['Drone Regions'], leads_to: ['Pochven'], ship_size: 'up to Battleship', total_mass: '1 000 000 000 kg', life_time: '12h' },
  { wormhole: 'U574', respawn: ['Static', 'Wandering'], spawn_in: ['Class 4'], leads_to: ['C6'], ship_size: 'up to Battleship', total_mass: '3 000 000 000 kg', life_time: '24h' },
  { wormhole: 'V283', respawn: ['Wandering'], spawn_in: ['HighSec'], leads_to: ['NS'], ship_size: 'up to Freighter', total_mass: '3 000 000 000 kg', life_time: '16h' },
  { wormhole: 'V301', respawn: ['Wandering'], spawn_in: ['Class 3', 'Class 12 - Thera'], leads_to: ['C1'], ship_size: 'up to Battlecruiser', total_mass: '500 000 000 kg', life_time: '16h' },
  { wormhole: 'V753', respawn: ['Static', 'Wandering'], spawn_in: ['Class 5'], leads_to: ['C6'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '24h' },
  { wormhole: 'V898', respawn: ['Static'], spawn_in: ['Class 12 - Thera'], leads_to: ['LS'], ship_size: 'up to Freighter', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'V911', respawn: ['Static', 'Wandering'], spawn_in: ['Class 6'], leads_to: ['C5'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '24h' },
  { wormhole: 'V928', respawn: ['Wandering'], spawn_in: ['HighSec', 'LowSec', 'NullSec', 'Jove Observatories'], leads_to: ['Sanctified Vidette'], ship_size: 'up to Battleship', total_mass: '750 000 000 kg', life_time: '16h' },
  { wormhole: 'W237', respawn: ['Static', 'Wandering'], spawn_in: ['Class 6'], leads_to: ['C6'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '24h' },
  { wormhole: 'X450', respawn: ['Wandering'], spawn_in: ['Pochven ▲ Trig space'], leads_to: ['NS'], ship_size: 'up to Battleship', total_mass: '1 000 000 000 kg', life_time: '12h' },
  { wormhole: 'X702', respawn: ['Wandering'], spawn_in: ['HighSec', 'LowSec', 'NullSec'], leads_to: ['C3'], ship_size: 'up to Battleship', total_mass: '1 000 000 000 kg', life_time: '24h' },
  { wormhole: 'X877', respawn: ['Static', 'Wandering'], spawn_in: ['Class 4'], leads_to: ['C4'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'Y683', respawn: ['Static', 'Wandering'], spawn_in: ['Class 2', 'Drifter wormholes'], leads_to: ['C4'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'Y790', respawn: ['Static'], spawn_in: ['Class 5'], leads_to: ['C1'], ship_size: 'up to Battlecruiser', total_mass: '500 000 000 kg', life_time: '16h' },
  { wormhole: 'Z006', respawn: ['Wandering'], spawn_in: ['Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6', 'Class 12 - Thera', 'Class 13 - Shattered'], leads_to: ['C3'], ship_size: 'up to Destroyer', total_mass: '3 000 000 000 kg', life_time: '4.5h' },
  { wormhole: 'Z060', respawn: ['Static'], spawn_in: ['Class 1'], leads_to: ['NS'], ship_size: 'up to Battlecruiser', total_mass: '1 000 000 000 kg', life_time: '16h' },
  { wormhole: 'Z142', respawn: ['Wandering'], spawn_in: ['Class 5', 'Class 6'], leads_to: ['NS'], ship_size: 'up to Capital', total_mass: '3 300 000 000 kg', life_time: '16h' },
  { wormhole: 'Z457', respawn: ['Static', 'Wandering'], spawn_in: ['Class 6'], leads_to: ['C4'], ship_size: 'up to Battleship', total_mass: '2 000 000 000 kg', life_time: '16h' },
  { wormhole: 'Z647', respawn: ['Static', 'Wandering'], spawn_in: ['Class 2', 'Drifter wormholes'], leads_to: ['C1'], ship_size: 'up to Battlecruiser', total_mass: '500 000 000 kg', life_time: '16h' },
  { wormhole: 'Z971', respawn: ['Wandering'], spawn_in: ['HighSec', 'LowSec', 'NullSec'], leads_to: ['C1'], ship_size: 'up to Battlecruiser', total_mass: '100 000 000 kg', life_time: '16h' },
  { wormhole: 'GEAR', respawn: [], spawn_in: [], leads_to: ['drifter blackhole'], ship_size: null, total_mass: null, life_time: null },
  { wormhole: 'K162', respawn: [], spawn_in: ['EXIT'], leads_to: ['jump to identify'], ship_size: null, total_mass: null, life_time: null },
];
