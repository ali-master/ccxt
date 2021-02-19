<?php

namespace ccxtpro;

use Ds\Deque;

class ArrayCacheBySymbolById extends ArrayCacheByTimestamp {
    private $index;
    private $index_tracker;

    public function __construct($max_size = null) {
        parent::__construct($max_size);
        $this->index = new Deque();
    }

    public function append($item) {
        if (array_key_exists($item['symbol'], $this->hashmap)) {
            $by_id = &$this->hashmap[$item['symbol']];
        } else {
            $by_id = array();
            $this->hashmap[$item['symbol']] = &$by_id;
        }
        if (array_key_exists($item['id'], $by_id)) {
            $prev_ref = &$by_id[$item['id']];
            # updates the reference
            $prev_ref = $item;
            $index = $this->index->find($item['id']);
            unset($this->index[$index]);
            unset($this->deque[$index]);
        } else {
            $by_id[$item['id']] = &$item;
            if ($this->deque->count() === $this->max_size) {
                $this->deque->shift();
                $delete_reference = $this->index->shift();
                unset($by_id[$delete_reference]);
            }
        }
        # this allows us to effectively pass by reference
        $this->deque->push(null);
        $this->deque[$this->deque->count() - 1] = &$item;
        $this->index->push($item['id']);
        if ($this->clear_updates) {
            $this->clear_updates = false;
            $this->new_updates = 0;
        }
        $this->new_updates++;
    }
}
