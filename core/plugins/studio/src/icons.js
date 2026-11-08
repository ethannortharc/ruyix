// A studio's icon, by name (its declaration's `icon`): the names are lib/declare.js's STUDIO_ICONS (the declaration
// check holds a studio to them), each mapped to its picture here, so the page carries only these.
import { BookOpen, Boxes, Briefcase, Camera, Clapperboard, Code, Feather, FlaskConical, GraduationCap, Heart, Image as ImageIcon, Megaphone, Mic, Music, Newspaper, PenLine, ShoppingBag, Sparkles, Video } from 'lucide-react'
import { STUDIO_ICONS as NAMES } from '../lib/declare.js'

const BY_NAME = { Feather, PenLine, Clapperboard, Camera, Video, Music, Mic, BookOpen, Newspaper, Megaphone, Briefcase, ShoppingBag, Image: ImageIcon, Code, FlaskConical, GraduationCap, Heart, Sparkles, Boxes }
export const STUDIO_ICONS = Object.fromEntries(NAMES.map(n => [n, BY_NAME[n] || Boxes]))
export const studioIcon = name => STUDIO_ICONS[name] || Boxes
/** Names in the list with no picture here (to be none: the check says so). */
export const missingIcons = () => NAMES.filter(n => !BY_NAME[n])
