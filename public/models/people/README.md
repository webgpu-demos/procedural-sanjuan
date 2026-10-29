# People

`m01.glb`: Male_Adult_01 of the [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) avatar library, with its clips m_idle_neutral_01, m_walk_neutral_01, m_run_neutral_01, m_walk_fast_01 (in place) and the first frame of m_sit_chair_idle_neutral_01; converted with Blender (`tools/assets/rocketbox_to_glb.py`) to glTF: the clips retargeted onto the avatar's skeleton (each bone turned as its namesake turns in the world, baked), textures 1024 px WebP, specular maps dropped. `crowd/`: the people on foot (src/world/people.js), 38 avatars of the same library chosen for a San Juan street: everyday
clothes for the heat (shirts, polos, t-shirts, jeans, shorts, skirts, a dress), office clothes, a clinic's whites and
scrubs, a security guard, two workers, two runners, two in swimwear for the beach, and three children; not the library's
winter coats and jackets, its uniforms of other countries' police, soldiers and firefighters, or its headscarves, robes
and veils, which are not what San Juan's streets look like. Converted with Blender (`tools/assets/crowd.py`): the
skeleton cut to 22 bones (fingers and face folded into the hand and the head), the body in three levels of detail
(about 5,200, 1,600 and 480 triangles, the hair and lashes besides), the colour maps in one 768 x 512 atlas with the
skin marked in its alpha (`crowd_atlas.py`: the client gives the same person another skin tone); the clips
(f_/m_ walk_neutral_01 and 02, walk_stroll_01, walk_fast_01, run_slow_01, idle_neutral_01, idle_waiting_01,
cell_phone_textmessage, idle_look_around_01, gestic_talk_relaxed_01, sit_chair_idle_neutral_01, m_cell_phone_talk_01)
retargeted onto the women's and the men's skeletons (`f-*.glb`, `m-*.glb`); packed with gltfpack
(`crowd_pack.mjs`: meshopt). Which avatar is who: `crowd/people.json`. `f-moves.glb`, `m-moves.glb`: transitions
between those clips (setting off, stopping from either foot, standing up) generated with NVIDIA's MotionBricks
(github.com/NVlabs/motionbricks; the model under the NVIDIA Open Model Agreement, which claims no ownership of its
outputs) from the clips' own poses, on the same skeletons (`tools/motion/transitions.py`; `moves.json`: their lengths).

Used under the MIT License:

> MIT License
> 
> Copyright (c) 2020 Microsoft
> 
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
> 
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
> 
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
