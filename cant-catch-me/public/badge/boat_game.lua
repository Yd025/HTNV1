--[==[badge-app
slug=controller
name=Game Controller
icon=CTRL
api=2
]==]

-- Compatible with the original game-script controller's USB log protocol.
local previous = {}
local tick_count = 0
local buttons = {
    { "UP", "W" }, { "DOWN", "S" },
    { "LEFT", "A" }, { "RIGHT", "D" },
    { "START", "START" }, { "A", "CAMERA" }, { "B", "LOOK" }
}

function on_enter(root)
    previous = {}
    tick_count = 0
    local bg = badge.ui.box(root, 320, 240)
    bg:style({ bg_color = 0x183d4c })
    bg:align("center", 0, 0)
    local label = badge.ui.label(root,
        "CAN'T CATCH ME\n\nUp: accelerate  Down: brake\nLeft / Right: steer\nStart: play / pause\nA: camera  B: look back")
    label:style({ text_color = 0xedf4ee })
    label:align("center", 0, 0)
    badge.led.clear()
    badge.led.show()
    badge.sys.log("HELLO_GAME")
end

function on_tick()
    tick_count = tick_count + 1
    local any_down = false
    for _, mapping in ipairs(buttons) do
        local code = badge.input.BUTTON[mapping[1]]
        local down = code ~= nil and badge.input.is_down(code) or false
        if tick_count > 1 and down ~= (previous[mapping[2]] or false) then
            badge.sys.log(mapping[2] .. (down and "_DOWN" or "_UP"))
        end
        previous[mapping[2]] = down
        any_down = any_down or down
    end
    -- Re-send held state periodically so connecting midway through a hold
    -- and recovering from a dropped serial chunk both settle correctly.
    if tick_count == 1 or tick_count % 30 == 0 then
        badge.sys.log("HEARTBEAT")
        local state = "STATE:"
        for _, mapping in ipairs(buttons) do
            state = state .. (previous[mapping[2]] and "1" or "0")
        end
        badge.sys.log(state)
    end
    if any_down then badge.led.set_all(0, 90, 40)
    else badge.led.set_all(0, 0, 20) end
    badge.led.show()
end

function on_exit()
    for _, mapping in ipairs(buttons) do
        badge.sys.log(mapping[2] .. "_UP")
    end
    badge.sys.log("GOODBYE_GAME")
    badge.led.clear()
    badge.led.show()
end
