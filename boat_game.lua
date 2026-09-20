--[==[badge-app
slug=controller
name=Game Controller
icon=CTRL
api=2
]==]

function on_enter(root)
    local bg = badge.ui.box(root, 320, 240)
    bg:style({ bg_color = 0x000000 })
    bg:align("center", 0, 0)

    local lbl = badge.ui.label(root, "PC Controller\n\nUse D-Pad to steer.")
    lbl:style({ text_color = 0x00ff00 })
    lbl:align("center", 0, 0)
    
    badge.led.clear()
    badge.led.show()
    badge.sys.log("HELLO_GAME")
end

local was_up = false
local was_left = false
local was_right = false
local was_start = false
local tick_count = 0

function on_tick()
    tick_count = tick_count + 1
    if tick_count % 30 == 0 then
        badge.sys.log("HEARTBEAT")
    end

    local is_up = badge.input.is_down(badge.input.BUTTON.UP)
    local is_left = badge.input.is_down(badge.input.BUTTON.LEFT)
    local is_right = badge.input.is_down(badge.input.BUTTON.RIGHT)
    local is_start = badge.input.is_down(badge.input.BUTTON.START)
    
    if is_up ~= was_up then
        badge.sys.log(is_up and "W_DOWN" or "W_UP")
        was_up = is_up
    end
    if is_left ~= was_left then
        badge.sys.log(is_left and "A_DOWN" or "A_UP")
        was_left = is_left
    end
    if is_right ~= was_right then
        badge.sys.log(is_right and "D_DOWN" or "D_UP")
        was_right = is_right
    end
    if is_start ~= was_start then
        badge.sys.log(is_start and "START_DOWN" or "START_UP")
        was_start = is_start
    end
    
    -- LEDs to show presses
    if is_up or is_left or is_right or is_start then
        badge.led.set_all(0, 255, 0)
    else
        badge.led.set_all(0, 0, 50)
    end
    badge.led.show()
end
